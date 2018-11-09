import * as vscode from 'vscode';
import * as vlocity from 'vlocity';
import * as jsforce from 'jsforce';
import * as path from 'path';
import * as process from 'process';
import * as l from '../loggers';
import * as s from '../singleton';
import { isBuffer, isString, isObject, isError } from 'util';
import { getDocumentBodyAsString, readdirAsync, fstatAsync, getStackFrameDetails, forEachProperty, getProperties } from '../util';

declare var VlocityUtils: any;

export interface ManifestEntry {
    datapackType: string;
    key: string;
}

export interface ObjectEntry {
    sobjectType: string;
    datapackType: string;
    globalKey?: string;
    name?: String;
    id?: String;
}

type ObjectEntryWithId = ObjectEntry & { id: string; };

export enum DatapackCommandOutcome {
    success = 0,
    partial = 1,
    error = 2
}

export enum VlocityJobStatus {
    success = 'Success',
    error = 'Error'
}

export interface DatapackCommandResult {
    outcome: DatapackCommandOutcome;
    totalCount: number;
    missingCount?: number;
    errors: { error: string, key: string }[];
    success: string[];
}

type ExportManifest = { 
    [type: string] : { 
        [id: string] : { 
            Id: string, 
            VlocityDataPackType: string, 
            VlocityRecordSObjectType: string 
        } 
    } 
};

type ExportQueryArray = Array<{ 
    VlocityDataPackType: string, 
    query: string 
}>;

/**
 * Simple representation of a datapack; maps common values to properties. Source of the datapsck can be accessed through the `data` property
 */
export class VlocityDatapack implements ManifestEntry, ObjectEntry {
    private _data: any;
    private _headerFile: string;
    private _key: string;
    private _type: string;

    public get hasGlobalKey(): boolean { return this.globalKey !== undefined && this.globalKey !== null; }
    public get globalKey(): string { return this._data['%vlocity_namespace%__GlobalKey__c']; }
    public get name(): string { return this._data['Name']; }
    public get datapackType(): string { return this._type; }
    public get sobjectType(): string { return this._data['VlocityRecordSObjectType']; }
    public get sourceKey(): string { return this._data['VlocityRecordSourceKey']; }
    public get data(): any { return this._data; }
    public get key(): string { return this._key; }    
    public get mainfestEntry(): ManifestEntry { return { key: this._key, datapackType: this._type }; }
    
    constructor(headerFile: string, type: string, key: string, data?: any) {
        this._headerFile = headerFile;
        this._type = type;
        this._key = key;        
        if (isBuffer(data)) {
            data = data.toString();
        }        
        if (isString(data)) {
            try {
                this._data = JSON.parse(data);
            } catch (err) {
                s.get(l.Logger).error('Unable to parse datapack JSON: ' + (err.message || err));
            }
        } else if (isObject(data)) {
            this._data = data;
        } else {
            this._data = {};
        }
    }
}

export default class VlocityDatapackService {  

    private options: vlocity.JobOptions;
    private _vlocityBuildTools: vlocity;
    private _jsforceConnection: jsforce.Connection;

    constructor(options?: vlocity.JobOptions) {
        this.options = options || {};
    }
     
    private get vlocityBuildTools() : vlocity {
        return this._vlocityBuildTools || (this._vlocityBuildTools = this.createVlocityInstance());        
    }    

    private createVlocityInstance() : vlocity {
        const buildTools = new vlocity(this.options);
        buildTools.datapacksutils.printJobStatus = () => {};
        buildTools.datapacksutils.saveCurrentJobInfo = () => {};
        buildTools.datapacksexportbuildfile.saveFile = () => {};
        return buildTools;
    }

    public get vlocityNamespace() : string {
        return this.vlocityBuildTools.namespace;        
    } 

    public get queryDefinitions() {
        return this.vlocityBuildTools.datapacksjob.queryDefinitions;
    }

    protected get logger() {
        return s.get(l.Logger);
    }

    public async getJsForceConnection() : Promise<jsforce.Connection> {
        await this.checkLoginAsync();
        return this._vlocityBuildTools.jsForceConnection;
    }

    public async isVlocityPackageInstalled() : Promise<Boolean> {
        return (await this.getVlocityPackageDetails()) !== undefined;
    }

    private async getVlocityPackageDetails() : Promise<jsforce.FileProperties | undefined> {
        let con = await this.getJsForceConnection();
        let results = await con.metadata.list( { type: 'InstalledPackage' });        
        return results.find(packageInfo => /^vlocity/i.test(packageInfo.fullName));
    }
    
    public async loadDatapackFromFile(file: vscode.Uri) : Promise<VlocityDatapack> {
        this.logger.log(`Loading datapack: ${file.fsPath}`);
        let mainfestEntry = this.getDatapackManifestKey(file);
        return new VlocityDatapack(file.fsPath, mainfestEntry.datapackType, mainfestEntry.key, await getDocumentBodyAsString(file));
    }

    private resolveProjectPathFor(file: vscode.Uri) : string {
        if (path.isAbsolute(this.options.projectPath)) {
            return this.options.projectPath || '';
        }
        let rootFolder = vscode.workspace.getWorkspaceFolder(file);
        return rootFolder 
            ? path.resolve(rootFolder.uri.fsPath, this.options.projectPath) 
            : path.resolve(this.options.projectPath);
    }

    public getDatapackManifestKey(file: vscode.Uri) : ManifestEntry {
        let filePath = file.fsPath; // always passed as absolute path
        let projectPath = this.resolveProjectPathFor(file);
        let relativePath = filePath.replace(projectPath,'');
        let splitedPath = relativePath.split(/\/|\\/gm).filter(v => !!v);
        return {
            datapackType: splitedPath[0],
            key: `${splitedPath.slice(1, splitedPath.length - 1).join('/')}`
        };        
    }

    public deploy(mainfest: ManifestEntry[]) : Promise<DatapackCommandResult>  {
        return this.runCommand('Deploy',{
            manifest: this.createDeployManifest(mainfest)
        }).then(result => {
            result.missingCount = Math.max(result.totalCount - mainfest.length, 0);
            return result;
        });
    }

    public export(entries: ObjectEntry[], maxDepth: number = 0) : Promise<DatapackCommandResult>  {
        const exportQueries = this.createExportQueries(entries.filter(e => !e.id));
        const exportMainfest = this.createExportManifest(<ObjectEntryWithId[]>entries.filter(e => !!e.id));
        return this.runCommand('Export',{
            queries: exportQueries,
            fullManifest: exportMainfest,
            skipQueries: exportQueries.length == 0,
            maxDepth: maxDepth
        }).then(result => {
            result.missingCount = Math.max(result.totalCount - entries.length, 0);
            return result;
        });
    }

    private createExportManifest(objects: ObjectEntryWithId[]) : ExportManifest  {
        let mainfest = objects.reduce((mainfest, entry) => {
            mainfest[entry.datapackType] = mainfest[entry.datapackType] || {};
            mainfest[entry.datapackType][entry.id] = {
                Id: entry.id,
                VlocityDataPackType: entry.datapackType,
                VlocityRecordSObjectType: entry.sobjectType
            };
            return mainfest;
        }, {});
        return mainfest;
    }

    private createExportQueries(objects: ObjectEntry[]) : ExportQueryArray {
        return objects.map(entry => [{
                VlocityDataPackType: entry.datapackType || 'SObject',
                query: this.buildQuery(entry)
            }][0]
        );
    }

    private buildQuery(entry: ObjectEntry) : string {
        if (!entry.globalKey && !entry.name) {
            throw new Error(`Cannot export object without name or global key (${entry.sobjectType})`);
        }
        // determine the base query
        let query = this.getDefaultQuery(entry.datapackType);
        if (!query) {
            this.logger.warn('No default query available for datapack of type ${(entry.datapackType}; building generic query instead');
            query = `select Id from ${entry.sobjectType}`;
        }
        // append query conditions
        query += / where /gi.test(query) ? ' and ' : ' where ';
        if (entry.globalKey) {
            query += `%vlocity_namespace%__GlobalKey__c = '${entry.globalKey}'`;
        } else {
            query += `Name = '${entry.name}'`;
        }
        return query;
    }

    private getDefaultQuery(datapackType: string) : string | undefined {
        if (this.queryDefinitions[datapackType]) {
            return this.queryDefinitions[datapackType].query;
        }
        return undefined;
    }

    /**
     * Tries to get the Vlocity datapack type for a specified SObject type, this 
     * will not work for objects that are associated with multiple datapacks types, i.e: OmniScripts
     * @param sobjectType Salesforce object type, replace Vlocity namespace with %vlocity_namespace%
     */
    public getDatapackType(sobjectType: string) : string | undefined {
        return Object.keys(this.queryDefinitions).find(type => {
            return new RegExp(`from ${sobjectType}`,'ig').test(this.queryDefinitions[type].query);
        });
    }

    private createDeployManifest(objects: ManifestEntry[]) : any {
        return objects.reduce((mf, item) => {  
            mf[item.datapackType] = mf[item.datapackType] || [];
            mf[item.datapackType].push(item.key);
            return mf;
        }, {});
    }

    /**
     * Finds the datapacks header JSON by scanning the directory for files post fixed with _datapack.json
     * @param file file or folder for which to find the _datapack.json file
     */
    public async resolveDatapackHeader(file: vscode.Uri) : Promise<vscode.Uri> {
        if (file.fsPath.toLowerCase().endsWith('_datapack.json')) {
            return file;
        }
        try{
            // either detect based on ending or do a full stat command
            let isDirectory = file.fsPath.endsWith(path.sep) || (await fstatAsync(file)).isDirectory();
            if (isDirectory) {
                return this.findDatapackHeaderInFolder(file.fsPath);
            }
            return this.findDatapackHeaderInFolder(path.dirname(file.fsPath));
        } catch (err) {
            // catch fstatAsync exceptions; this indeicates tha file does not exoist and as such we
            // return undefined indicating the DP header cannot be resolved.
            return undefined;
        }
    }

    private async findDatapackHeaderInFolder(pathStr: string) : Promise<vscode.Uri> {
        try {
            let files = await readdirAsync(pathStr);
            let datapackFile = files.find(f => f.toLowerCase().endsWith('_datapack.json'));
            return datapackFile ? vscode.Uri.file(path.join(pathStr, datapackFile)) : undefined;
        } catch (err) {
            // in case this is not a folder readdirAsync will return an exception
            // which we will catch and for that return a undefined aka not found result 
            return undefined;
        }
    }

    public async runCommand(command: vlocity.actionType, jobInfo : vlocity.JobInfo) : Promise<DatapackCommandResult> {
        let jobResult : vlocity.VlocityJobResult;
        try {
            await this.checkLoginAsync();
            jobResult = await this.datapacksjobAsync(command, jobInfo);
        } catch (err) {
            if (isError(err)) {
                throw err;
            }
            jobResult = <vlocity.VlocityJobResult>err;
        }
        return this.parseJobResult(jobResult);
    }

    private checkLoginAsync() : Promise<void> {
        return new Promise((resolve, reject) => {
            process.chdir(vscode.workspace.rootPath);
            
            return this.vlocityBuildTools.checkLogin(resolve, reject);
        });
    }

    private datapacksjobAsync(command: vlocity.actionType, jobInfo : vlocity.JobInfo) : Promise<vlocity.VlocityJobResult> {
        return new Promise((resolve, reject) => {
            // collect and create job optipns
            const localOptions = { projectPath: this.options.projectPath || '.' };
            const jobOptions = Object.assign({}, this.options, jobInfo, localOptions);
            // clean-up build tools left overs from the last invocation
            this.vlocityBuildTools.datapacksexportbuildfile.currentExportFileData = {};
            delete this.vlocityBuildTools.datapacksbuilder.allFileDataMap;
            // run the jon
            return this.vlocityBuildTools.datapacksjob.runJob(command, jobOptions, resolve, reject);
        });
    }

    private parseJobResult(result: vlocity.VlocityJobResult) : DatapackCommandResult {
        const errorRecords = (result.records || []).filter(r => r.VlocityDataPackStatus != VlocityJobStatus.success);
        const successRecords = (result.records || []).filter(r => r.VlocityDataPackStatus == VlocityJobStatus.success);
        let outcome = DatapackCommandOutcome.success;

        if (successRecords.length > 0 && errorRecords.length > 0) {
            outcome = DatapackCommandOutcome.partial;
        }  else if (errorRecords.length == 0) {
            outcome = DatapackCommandOutcome.success;
        } else if (successRecords.length == 0) {
            outcome = DatapackCommandOutcome.error;
        }

        return {
            outcome: outcome, 
            totalCount: (result.records || []).length,
            success: successRecords.map(r => r.VlocityDataPackKey),
            errors: errorRecords.map(r => [{ error: r.ErrorMessage, key: r.VlocityDataPackKey }][0])
        };
    }
}

export function setLogger(logger : l.Logger, includeCallerDetails: Boolean = false){
    const vlocityLogFn = (logFn: (...args: any[]) => void, args: any[]) : void => {
        if (includeCallerDetails) {
            let callerFrame = getStackFrameDetails(2);
            args.push(`(${callerFrame.fileName}:${callerFrame.lineNumber})`);
        }
        logFn.apply(logger, args);
    };
    const vlocityLoggerMaping : { [ func: string ]: (...args: any[]) => void } = {
        report: logger.info,
        success: logger.info,
        warn: logger.warn,
        error: logger.error,
        verbose: logger.verbose        
    };
    // Override all methods
    getProperties(vlocityLoggerMaping).forEach(kvp => VlocityUtils[kvp.key] = (...args: any[]) => vlocityLogFn(kvp.value, args));
    VlocityUtils.fatal = (...args: any[]) => { throw new Error(Array.from(args).join(' ')); };
    VlocityUtils.output = (loggingMethod, color: string, args: IArguments) => vlocityLogFn(logger.log, Array.from(args));
}