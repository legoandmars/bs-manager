import { BSVersion } from "shared/bs-version.interface";
import { DownloadLink, InstallModsResult, Mod, ModInstallProgression, UninstallModsResult } from "shared/models/mods";
import { BeatModsApiService } from "./beat-mods-api.service";
import { BSLocalVersionService } from "../bs-local-version.service"
import path from "path";
import { UtilsService } from "../utils.service";
import md5File from "md5-file";
import fs from "fs"
import StreamZip from "node-stream-zip";
import { RequestService } from "../request.service";
import { spawn } from "child_process";
import { BS_EXECUTABLE } from "../../constants";
import log from "electron-log";

export class BsModsManagerService {

    private static instance: BsModsManagerService;

    private readonly beatModsApi: BeatModsApiService;
    private readonly bsLocalService: BSLocalVersionService;
    private readonly utilsService: UtilsService;
    private readonly requestService: RequestService

    private manifestMatches: Mod[];

    private nbModsToInstall = 0;
    private nbInstalledMods = 0;

    private nbModsToUninstall = 0;
    private nbUninstalledMods = 0;

    public static getInstance(): BsModsManagerService{
        if(!BsModsManagerService.instance){ BsModsManagerService.instance = new BsModsManagerService(); }
        return BsModsManagerService.instance;
    }

    private constructor(){
        this.beatModsApi = BeatModsApiService.getInstance();
        this.bsLocalService = BSLocalVersionService.getInstance();
        this.utilsService = UtilsService.getInstance();
        this.requestService = RequestService.getInstance();
    }

    private async getModFromHash(hash: string): Promise<Mod>{
        const allMods = await this.beatModsApi.getAllMods();
        return allMods.find(mod => {
            if(mod.name.toLowerCase() === "bsipa" || mod.status === "declined"){ return false; }
            return mod.downloads.some(download => download.hashMd5.some(md5 => md5.hash === hash));
        })
    }

    private async getIpaFromHash(hash: string): Promise<Mod>{
        const allMods = await this.beatModsApi.getAllMods();
        return allMods.find(mod => {
            if(mod.name.toLowerCase() !== "bsipa"){ return false; }
            return mod.downloads.some(download => download.hashMd5.some(md5 => md5.hash === hash));
        })
    }

    private async getModsInDir(version: BSVersion, modsDir: ModsInstallFolder): Promise<Mod[]>{
        const bsPath = await this.bsLocalService.getVersionPath(version);
        const modsPath = path.join(bsPath, modsDir);
        if(!this.utilsService.pathExist(modsPath)){ return []; }
        const files = fs.readdirSync(modsPath);
        const promises = files.map(f => {
            return (async() => {
                const filePath = path.join(modsPath, f)
                const ext = path.extname(f);
                if(ext !== ".dll" && ext !== ".exe" && ext !== ".manifest"){ return undefined; }
                const hash = await md5File(filePath);
                const mod = await this.getModFromHash(hash);
                if(!mod){ return undefined; }
                if(ext === ".manifest"){
                    this.manifestMatches.push(mod);
                    return undefined;
                }
                if(filePath.includes("Libs")){
                    if(!this.manifestMatches.some(m => m.name === mod.name)){ return undefined; }
                    const modIndex = this.manifestMatches.indexOf(mod);
                    if(modIndex > -1){ this.manifestMatches.splice(modIndex, 1); }
                }
                return mod;
            })()
        });
        const mods = await Promise.all(promises)
        return mods.filter(m => !!m);
    }

    private async getBsipaInstalled(version: BSVersion): Promise<Mod>{
        const bsPath = await this.bsLocalService.getVersionPath(version);
        const injectorPath = path.join(bsPath, "Beat Saber_Data", "Managed", "IPA.Injector.dll");
        if(!this.utilsService.pathExist(injectorPath)){ return undefined; }
        const injectorMd5 = await md5File(injectorPath);
        return this.getIpaFromHash(injectorMd5);
    }

    private async downloadZip(zipUrl: string): Promise<{zip: StreamZip.StreamZipAsync, zipPath: string}>{
        zipUrl = path.join(this.beatModsApi.BEAT_MODS_URL, zipUrl);
        const fileName = path.basename(zipUrl);
        const tempPath = this.utilsService.getTempPath();
        this.utilsService.createFolderIfNotExist(this.utilsService.getTempPath());
        const dest = path.join(tempPath, fileName);

        const zipPath = await this.requestService.downloadFile(zipUrl, dest);
        const zip = new StreamZip.async({file : zipPath});

        return {zip, zipPath};
    }

    private async executeBSIPA(version: BSVersion, args: string[]): Promise<boolean>{
        const versionPath = await this.bsLocalService.getVersionPath(version);
        const ipaPath = path.join(versionPath, "IPA.exe");
        const bsExePath = path.join(versionPath, BS_EXECUTABLE);
        if(!this.utilsService.pathExist(ipaPath) || !this.utilsService.pathExist(bsExePath)){ return false; }

        return new Promise<boolean>(resolve => {
            const processIPA = spawn(`start /wait /min "" "${ipaPath}" ${args.join(" ")}`, {cwd: versionPath, detached: true, shell: true});
            processIPA.once("exit", code => {
                if(code === 0){ return resolve(true); }
                log.error("IPA PROCESS", "exit code", code);
                resolve(false);
            });

            setTimeout(() => resolve(false), (1 * 60) * 1000); //timeout 1min
        });
    }

    private getModDownload(mod: Mod, version: BSVersion): DownloadLink{
        return mod.downloads.find(download => {
            const type = download.type.toLowerCase()
            return type === "universal" || type === this.bsLocalService.getVersionType(version);
        });
    }

    private async installMod(mod: Mod, version: BSVersion): Promise<boolean>{
    
        this.utilsService.ipcSend<ModInstallProgression>("mod-installed", {success: true, data: {name: mod.name, progression: ((this.nbInstalledMods + 1) / this.nbModsToInstall) * 100}}) 

        const download = this.getModDownload(mod, version);

        if(!download){ return false; }

        const {zip, zipPath} = await this.downloadZip(download.url);

        if(!zip){ return false; }

        const crypto = require('crypto');
        const entries = await zip.entries();

        const checkedEntries = (await Promise.all(Object.values(entries).map(async (entry) => {
            if(!entry.isFile){ return undefined; }
            const data = await zip.entryData(entry);
            const entryMd5 = crypto.createHash('md5').update(data).digest('hex')
            return download.hashMd5.some(md5 => md5.hash === entryMd5) ? entry : undefined;
        }))).filter(entry => !!entry);

        if(checkedEntries.length != download.hashMd5.length){ return false; }

        const verionPath = await this.bsLocalService.getVersionPath(version);
        const isBSIPA = mod.name.toLowerCase() === "bsipa";
        const destDir = isBSIPA ? verionPath : path.join(verionPath, ModsInstallFolder.PENDING);

        const extracted = await zip.extract(null, destDir).then(() => true).catch(err => {log.error(err); return false});

        await zip.close();
        await this.utilsService.unlinkIfExist(zipPath);

        const res = isBSIPA ? (extracted && (await this.executeBSIPA(version, ["-n"]))) : extracted;

        res && this.nbInstalledMods++;

        return res;
    }

    private isDependency(mod: Mod, selectedMods: Mod[], availableMods: Mod[]){
        return selectedMods.some(m => {
            const deps = m.dependencies.map(dep => Array.from(availableMods.values()).find(m => dep.name === m.name));
            if(deps.some(depMod => depMod.name === mod.name)){ return true; }
            return deps.some(depMod => depMod.dependencies.some(depModDep => depModDep.name === mod.name));
        });
    }

    private async resolveDependencies(mods: Mod[], version: BSVersion): Promise<Mod[]>{
        const availableMods = await this.beatModsApi.getVersionMods(version);
        return Array.from(new Map<string, Mod>(availableMods.reduce((res, mod) => {
            if(this.isDependency(mod, mods, availableMods)){
                res.push([mod.name, mod]);
            }
            return res;
        }, [])).values());
    }

    private async uninstallBSIPA(mod: Mod, version: BSVersion): Promise<void>{
        const download = this.getModDownload(mod, version);

        const verionPath = await this.bsLocalService.getVersionPath(version);
        const hasIPAExe = this.utilsService.pathExist(path.join(verionPath, "IPA.exe"));
        const hasIPADir = this.utilsService.pathExist(path.join(verionPath, "IPA"));

        if(!hasIPADir || !hasIPAExe){ return; }

        await this.executeBSIPA(version, ["--revert", "-n"]);

        const promises = download.hashMd5.map(files => {
            const file = files.file.replaceAll("IPA/", "").replaceAll("Data", "Beat Saber_Data");
            return this.utilsService.unlinkIfExist(path.join(verionPath, file));
        })
        
        await Promise.all(promises);
    }

    private async uninstallMod(mod: Mod, version: BSVersion): Promise<void>{

        this.nbUninstalledMods++;
        this.utilsService.ipcSend<ModInstallProgression>("mod-uninstalled", {success: true, data: {name: mod.name, progression: (this.nbUninstalledMods / this.nbModsToUninstall) * 100}}) 
        
        if(mod.name.toLowerCase() === "bsipa"){ return this.uninstallBSIPA(mod, version); }

        const download = this.getModDownload(mod, version);
        const versionPath = await this.bsLocalService.getVersionPath(version);

        const promises = download.hashMd5.map(async files => {
            this.utilsService.unlinkIfExist(path.join(versionPath, files.file));
            this.utilsService.unlinkIfExist(path.join(versionPath, "IPA", "Pending", files.file));
        });

        await Promise.all(promises);
    }

    public getAvailableMods(version: BSVersion): Promise<Mod[]>{
        return this.beatModsApi.getVersionMods(version);
    }

    public async getInstalledMods(version: BSVersion): Promise<Mod[]>{
        this.manifestMatches = [];
        await this.beatModsApi.loadAllMods();
        const bsipa = await this.getBsipaInstalled(version);
        return Promise.all([
            this.getModsInDir(version, ModsInstallFolder.PLUGINS_PENDING),
            this.getModsInDir(version, ModsInstallFolder.LIBS_PENDING),
            this.getModsInDir(version, ModsInstallFolder.PLUGINS),
            this.getModsInDir(version, ModsInstallFolder.LIBS)
        ]).then(dirMods => {
            const res = [];
            if(!!bsipa){ res.push(bsipa); }
            const installedMods = Array.from(new Map<string, Mod>(dirMods.flat().map(m => [m.name, m])).values());
            res.push(...installedMods);
            return res;
        });
    }

    public async installMods(mods: Mod[], version: BSVersion): Promise<InstallModsResult>{
        if(!mods || !mods.length){ throw "no-mods"; }

        const deps = await this.resolveDependencies(mods, version);
        mods.push(...deps);

        const bsipa = mods.find(mod => mod.name.toLowerCase() === "bsipa");
        if(bsipa){ mods = mods.filter(mod => mod.name.toLowerCase() !== "bsipa"); }

        this.nbModsToInstall = mods.length + (bsipa && 1);
        this.nbInstalledMods = 0;

        if(bsipa){
            const installed = await this.installMod(bsipa, version).catch(err => {log.error("INSTALL BSIPA", err); return false; })
            if(!installed){ throw "cannot-install-bsipa"; }
        }

        for(const mod of mods){
            await this.installMod(mod, version);;
        }

        return {
            nbModsToInstall: this.nbModsToInstall, 
            nbInstalledMods: this.nbInstalledMods
        };
    }

    public async uninstallMods(mods: Mod[], version: BSVersion): Promise<UninstallModsResult>{
        if(!mods || !mods.length){ throw "no-mods"; }

        this.nbModsToUninstall = mods.length;
        this.nbUninstalledMods = 0;

        for(const mod of mods){
            await this.uninstallMod(mod, version);
        }

        return {
            nbModsToUninstall: this.nbModsToUninstall,
            nbUninstalledMods: this.nbUninstalledMods
        };
    }

    public async uninstallAllMods(version: BSVersion): Promise<UninstallModsResult>{
        const mods = await this.getInstalledMods(version);

        if(!mods || !mods.length){ throw "no-mods"; }

        this.nbModsToUninstall = mods.length;
        this.nbUninstalledMods = 0;

        for(const mod of mods){
            await this.uninstallMod(mod, version);
        }

        const versionPath = await this.bsLocalService.getVersionPath(version);

        this.utilsService.rmDirIfExist(path.join(versionPath, ModsInstallFolder.PLUGINS));
        this.utilsService.rmDirIfExist(path.join(versionPath, ModsInstallFolder.LIBS));
        this.utilsService.rmDirIfExist(path.join(versionPath, ModsInstallFolder.IPA));

        path.resolve

        return {
            nbModsToUninstall: this.nbModsToUninstall,
            nbUninstalledMods: this.nbUninstalledMods
        };
    }

}

const enum ModsInstallFolder {
    PLUGINS = "Plugins",
    LIBS = "Libs",
    IPA = "IPA",
    PENDING = "IPA/Pending",
    PLUGINS_PENDING = "IPA/Pending/Plugins",
    LIBS_PENDING = "IPA/Pending/Libs"
}