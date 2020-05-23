const startTime = Date.now(); // Track start up performance

import OnSavedEventHandler from 'events/onSavedEventHandler';
import OnClassFileDeleted from 'events/onClassFileDeleted';
import OnClassFileCreated from 'events/onClassFileCreated';
import * as constants from '@constants';
import { LogManager, LogFilter, LogLevel } from 'lib/logging';
import { ConsoleWriter, OutputChannelWriter, TerminalWriter } from 'lib/logging/writers';
import Commands from 'commands';
import * as vlocityUtil from 'lib/vlocity/vlocityLogging';
import { initializeContext } from 'lib/vlocodeContext';
import DatapackProvider from 'treeDataProviders/datapackDataProvider';
import JobDataProvider from 'treeDataProviders/jobExplorer';
import ActivityDataProvider from 'treeDataProviders/activityDataProvider';
import { ConfigurationManager } from 'lib/configurationManager';
import * as vscode from 'vscode';
import * as vlocityPackageManifest from 'vlocity/package.json';
import VlocodeService from './lib/vlocodeService';
import VlocodeConfiguration from './lib/vlocodeConfiguration';

class VlocityLogFilter {
    private readonly vlocityLogFilterRegex = [
        /^(Initializing Project|Using SFDX|Salesforce Org|Continuing Export|Adding to File|Deploy [0-9]* Items).*/i,
        /^(Success|Remaining|Error).*?[0-9]+$/
    ];

    constructor() {
        return this.filter.bind(this);
    }

    public filter({ logger, args }) {
        if (LogManager.getLogLevel(logger.name) >= LogLevel.verbose) {
            return true;
        }
        return !this.vlocityLogFilterRegex.some(r => r.test(args.join(' ')));
    }
}

export = class Vlocode {

    private static instance: Vlocode;
    private service: VlocodeService;

    constructor() {
        if (!Vlocode.instance) {
            Vlocode.instance = this;
        }
        return Vlocode.instance;
    }

    private get logger() {
        return LogManager.get('vlocode');
    }

    private setWorkingDirectory() {
        if ((vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) > 0) {
            this.logger.verbose(`Updating Vlocode workspace folder to: ${vscode.workspace.workspaceFolders[0].uri.fsPath}`);
            process.chdir(vscode.workspace.workspaceFolders[0].uri.fsPath);
        } else {
            this.logger.warn('No workspace folders detected; Vlocode will not work properly without an active workspace');
        }
    }

    private startLogger() {
        // Simple switch that decides how to log
        const terminalWriter = this.service.registerDisposable(new TerminalWriter('Vlocode'));
        const outputChannelWriter = this.service.registerDisposable(new OutputChannelWriter('Vlocode'));

        LogManager.registerWriter({
            write: entry => {
                if (this.service.config.logInTerminal) {
                    return terminalWriter.write(entry);
                }
                outputChannelWriter.write(entry);
            }
        }, new ConsoleWriter());

        // set logging level
        LogManager.setGlobalLogLevel(this.service.config.verbose ? LogLevel.verbose : LogLevel.info); // todo: support more log levels from config section    
        ConfigurationManager.watchProperties(this.service.config, [ 'verbose' ], config => LogManager.setGlobalLogLevel(config.verbose ? LogLevel.verbose : LogLevel.info));

        // setup Vlocity logger and filters
        LogManager.registerFilter(LogManager.get('vlocity'), new VlocityLogFilter());
        vlocityUtil.setLogger(LogManager.get('vlocity'));
    }

    private async activate(context: vscode.ExtensionContext) {
        // All SFDX and Vloctiy commands work better when we are running from the workspace folder
        vscode.workspace.onDidChangeWorkspaceFolders(this.setWorkingDirectory.bind(this));
        this.setWorkingDirectory();

        // Init logging and register services
        const vloConfig = ConfigurationManager.load<VlocodeConfiguration>(constants.CONFIG_SECTION);
        this.service = new VlocodeService(vloConfig);
        context.subscriptions.push(this.service);

        initializeContext(context, this.service);
        this.startLogger();

        this.logger.info(`Vlocode version ${constants.VERSION} started`);
        this.logger.info(`Using built tools version ${vlocityPackageManifest.version}`);
        this.logger.verbose('Verbose logging enabled');

        // Salesforce support      
        ConfigurationManager.watchProperties(vloConfig, [ 'salesforce.enabled' ], c => this.service.enableSalesforceSupport(c.salesforce.enabled));
        if (vloConfig.salesforce.enabled) {
            this.service.enableSalesforceSupport(true);
        }

        // register commands and windows
        this.service.commands.registerAll(Commands);
        this.service.registerDisposable(vscode.window.createTreeView('datapackExplorer', {
            treeDataProvider: new DatapackProvider(this.service),
            showCollapseAll: true
        }));
        this.service.registerDisposable(vscode.window.createTreeView('jobExplorer', {
            treeDataProvider: new JobDataProvider(this.service)
        }));
        this.service.registerDisposable(vscode.window.createTreeView('activityView', {
            treeDataProvider: new ActivityDataProvider(this.service)
        }));

        this.service.registerDisposable(
            new OnSavedEventHandler(vscode.workspace.onDidSaveTextDocument, this.service)
        );
        const apexClassWatcher = this.service.registerDisposable(vscode.workspace.createFileSystemWatcher('**/src/classes/*.cls', false, true, false));
        this.service.registerDisposable(new OnClassFileCreated(apexClassWatcher.onDidCreate, this.service));
        this.service.registerDisposable(new OnClassFileDeleted(apexClassWatcher.onDidDelete, this.service));

        // track activation time
        this.logger.info(`Vlocode activated in ${Date.now() - startTime}ms`);
    }

    private async deactivate() {
        // Log to debug as other output channels will be disposed
        Vlocode.instance = null; // destroy instance
        console.debug('Vlocode extension deactivated');
    }

    static activate(context: vscode.ExtensionContext) {
        return new Vlocode().activate(context);
    }

    static deactivate() {
        return Vlocode.instance.deactivate();
    }
};