import { window, ExtensionContext, workspace } from 'vscode';
import VlocodeConfiguration from './models/vlocodeConfiguration';
import VlocodeService from './services/vlocodeService';
import * as constants from './constants';
import { LogManager, LogWriter, WriterChain, ConsoleWriter, OutputChannelWriter, LogFilterProxy, LogLevel }  from './loggers';
import CommandRouter from './services/commandRouter';
import { setLogger as setVlocityLogger } from './services/vlocityDatapackService';
import DatapackExplorer from 'datapackExplorer';
import Commands from 'commands';
import { container } from 'serviceContainer';
import DatapackSavedEventHandler from 'events/datapackSavedEventHandler';

export function activate(context: ExtensionContext) : void {
    
    // Init logging and register services
    let vloConfig = new VlocodeConfiguration(constants.CONFIG_SECTION);
    let vloService = container.register(VlocodeService, new VlocodeService(container, context, vloConfig));

    // logging setup
    container.register(LogWriter, new WriterChain(new ConsoleWriter(), new OutputChannelWriter(vloService.outputChannel)));
    LogManager.setGlobalLogLevel(vloConfig.verbose ? LogLevel.verbose : LogLevel.info); // todo: support more log levels from config section    
    vloConfig.watch(c => LogManager.setGlobalLogLevel(c.verbose ? LogLevel.verbose : LogLevel.info));

    LogManager.get('vlocode').info(`Vlocode version ${constants.VERSION} started`);
    LogManager.get('vlocode').verbose(`Verbose logging enabled`);    
    
    // setup Vlocity logger and filters
    const vlocityLogFilterRegex = [
        /^(Initializing Project|Using SFDX|Salesforce Org|Continuing Export|Adding to File|Deploy [0-9]* Items).*/i,
        /^(Success|Remaining|Error).*?[0-9]+$/
    ];
    LogManager.registerFilter('vlocity', (_level, ...args: any[]) => {
        if (LogManager.getGlobalLogLevel() >= LogLevel.verbose) {
            return true;
        }
        return !vlocityLogFilterRegex.some(r => r.test(args.join(' ')));
    });
    setVlocityLogger(LogManager.get('vlocity'));

    // register commands and windows
    container.get(CommandRouter).registerAll(Commands);
    vloService.registerDisposable(window.registerTreeDataProvider('datapackExplorer', new DatapackExplorer(container)));
    vloService.registerDisposable(new DatapackSavedEventHandler(workspace.onDidSaveTextDocument));
}

export function isDatapack() {
    console.log('isDatapack');
    console.log(arguments);
}

export function deactivate() { }