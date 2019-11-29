import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as constants from '@constants';
import ServiceContainer from 'serviceContainer';
import VlocodeService from './services/vlocodeService';
import VlocityDatapackService, { ObjectEntry } from './services/vlocityDatapackService';
import SObjectRecord from './models/sobjectRecord';
import ExportDatapackCommand from './commands/exportDatapackCommand';
import OpenSalesforceCommand from './commands/openSalesforceCommand';
import CommandRouter from './services/commandRouter';
import { LogManager, Logger } from 'logging';
import DatapackUtil from 'datapackUtil';
import { groupBy, evalExpr } from './util';
import * as yaml from 'js-yaml';

import * as exportQueryDefinitions from 'exportQueryDefinitions.yaml';
import { createRecordProxy, addFieldsToQuery } from 'salesforceUtil';
import VlocityJobFile from 'models/VlocityJobFile';

export default class JobExplorer implements vscode.TreeDataProvider<JobNode> {
    
    private readonly _onDidChangeTreeData: vscode.EventEmitter<JobNode | undefined>;

	get onDidChangeTreeData(): vscode.Event<JobNode | undefined> {
		return this._onDidChangeTreeData.event;
    }
    
    constructor(private readonly container: ServiceContainer) {
        this._onDidChangeTreeData = new vscode.EventEmitter<JobNode | undefined>()
        this.commands.registerAll({
            'vlocity.jobExplorer.run': async (node) => this.runJob(node),
            'vlocity.jobExplorer.open': OpenSalesforceCommand,
            'vlocity.jobExplorer.refresh': () => this.refresh()
        });
    }

    private async runJob(node: JobNode) {
        // if (node.nodeType == DatapackNodeType.Category) {
        //     // Collect all exportable nodes
        //     const children = await this.withProgress('Loading exportable datapacks...', this.getChildren(node));
            
        //     const exportableNodes = children.map(node => {
        //         if (node instanceof DatapackObjectGroupNode) {
        //             const record = node.records.slice(-1)[0];
        //             return record ? <ObjectEntry>{ 
        //                 id: record.Id, 
        //                 datapackType: node.datapackType, 
        //                 sobjectType: record.attributes.type
        //             } : undefined;
        //         } 
        //         return node;
        //     }).filter(node => node !== undefined);

        //     this.commands.execute(constants.VlocodeCommand.exportDatapack, ...exportableNodes);
        // } else if (node.nodeType == DatapackNodeType.Object) {
        //     this.commands.execute(constants.VlocodeCommand.exportDatapack, node);
        // }
    }

    // private withProgress<T>(title: string, task: Thenable<T>): Thenable<T> {
    //     return vscode.window.withProgress({ 
    //         location: vscode.ProgressLocation.Notification, 
    //         title: title,
    //         cancellable: false
    //     }, () => task);
    // }

    private get datapackService() : VlocityDatapackService {
        return this.vlocode.datapackService;
    }

    private get vlocityNamespace() : string {         
        return this.datapackService.vlocityNamespace;
    }
    
    private get vlocode() : VlocodeService {
        return this.container.get(VlocodeService);
    }

    private get logger() : Logger {
        return LogManager.get(JobExplorer);
    }
    
    private get commands() : CommandRouter {
        return this.container.get(CommandRouter);
    }
    
    public getAbsolutePath(path: string) {
        return this.vlocode.getContext().asAbsolutePath(path);
    }

    public refresh(node?: JobNode): void {
        this._onDidChangeTreeData.fire(node);
    }

    public getTreeItem(node: JobNode): vscode.TreeItem {
        return {
            label: node.getItemLabel(),
            resourceUri: node.jobFile,
            command: {
                title: 'Open',                
                command: 'vscode.open',
                arguments: [ node.jobFile ]
            },
            tooltip: node.getItemTooltip(),
            iconPath: node.getItemIconPath(),
            description: node.getItemDescription(),
            collapsibleState: vscode.TreeItemCollapsibleState.None
        };
    }

    private isValidJob(job: VlocityJobFile) {
        if (Array.isArray(job.queries)) {
            return job.queries.every(query => !!query.VlocityDataPackType);
        }
        return false;
    }

    public async getChildren(node?: JobNode): Promise<JobNode[]> {
        const yamlFiles = await vscode.workspace.findFiles('*.yaml');
        const yamlFilesWithBody = await Promise.all(yamlFiles.map(async file => {
            try {
                return {
                    file,
                    body: yaml.safeLoad((await fs.readFile(file.fsPath)).toString('utf8'), { filename: file.fsPath })
                }
            } catch(err) {
                this.logger.error(`Unable to load YAML file ${file} due to parsing error: ${err.message || err}`);
            }
        }));

        // remote any non-job files
        this.logger.info(`Found ${yamlFilesWithBody.length} YAML files in workspace folders`);        
        const validJobFiles = yamlFilesWithBody.filter((file) => file && this.isValidJob(file.body));
        this.logger.info(`Displaying ${validJobFiles.length} valid Job files in Job explorer`);
        
        //await this.vlocode.validateAll(true);
        return validJobFiles.map(({ file, body }) => new JobNode(this, file, body));
    }
}

class JobNode {    
    constructor(
        private readonly explorer: JobExplorer,
        public readonly jobFile: vscode.Uri,
        public readonly job: VlocityJobFile,
        public icon: { light: string, dark: string } | string = undefined
    ) { }

    public getItemLabel() : string {
        return path.basename(this.jobFile.fsPath);
    }

    public getItemTooltip() : string {
        return this.jobFile.fsPath;
    }

    public getItemDescription() : string {
        return vscode.workspace.asRelativePath(this.jobFile);
    }

    public getItemIconPath() : { light: string, dark: string } | string | undefined {
        if(!this.icon) {
            return undefined;
        }
        if (typeof this.icon === 'string') {
            return this.explorer.getAbsolutePath(this.icon);
        }
        if (typeof this.icon === 'object') {
            return {
                light: this.explorer.getAbsolutePath(this.icon.light),
                dark: this.explorer.getAbsolutePath(this.icon.dark)
            };
        }
    }
}