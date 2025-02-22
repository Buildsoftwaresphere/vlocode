import * as vscode from 'vscode';
import { SalesforceDebugLevel } from '@lib/salesforce/salesforceService';
import MetadataCommand from './metadataCommand';

/**
 * Clears all developer logs from the connected org
 */
export default class SetTraceFlagsCommand extends MetadataCommand {

    /**
     * Log level options to ask the user ot fill in
     */
    private readonly logLevelOptions = {
        apexCode: {
            placeHolder: 'APEX Code',
            default: 'Debug',
            options: ['None', 'Error', 'Warn', 'Info', 'Debug', 'Fine', 'Finer', 'Finest'],
            description: 'The log category level for Apex code. Includes information about Apex code. Can also include log messages generated by data manipulation language (DML) statements, inline SOQL or SOSL queries, the start and completion of triggers, the start and completion of test methods, and so on.',
        },
        apexProfiling: {
            placeHolder: 'Profiling',
            default: 'None',
            options: ['None', 'Info', 'Debug', 'Fine', 'Finest'],
            description: 'The log category level for profiling information. Includes cumulative profiling information, such as the limits for your namespace, the number of emails sent, and so on.',
        },
        callout: {
            placeHolder: 'Callouts',
            default: 'Info',
            options: ['None', 'Info', 'Finest'],
            description: 'The log category level for callouts. Includes the request-response XML that the server is sending and receiving from an external Web service. The request-response XML is useful when debugging issues related to SOAP API calls.',
        },
        database: {
            placeHolder: 'Database/DML',
            default: 'Info',
            options: ['None', 'Info', 'Finest'],
            description: 'The log category for database activity. Includes information about database activity, including every DML statement or inline SOQL or SOSL query.',
        },
        validation: {
            placeHolder: 'Validation',
            default: 'Info',
            options: ['None', 'Info'],
            description: 'The log category level for validation rules. Includes information about validation rules, such as the name of the rule, or whether the rule evaluated true or false.',
        },
        visualforce: {
            placeHolder: 'VisualForce',
            default: 'Fine',
            options: ['None', 'Info', 'Fine', 'Finest'],
            description: 'The log category level for Visualforce. Includes information about Visualforce events, including serialization and deserialization of the view state or the evaluation of a formula field in a Visualforce page.',
        },
        workflow: {
            placeHolder: 'Workflow',
            default: 'The log category level for workflow rules. Includes information for workflow rules, such as the rule name and the actions taken.',
            options: ['None', 'Error', 'Warn', 'Info', 'Debug', 'Fine', 'Finer', 'Finest'],
            description: 'Tets',
        },
        system: {
            placeHolder: 'System',
            default: 'Info',
            options: ['None', 'Info', 'Debug', 'Fine'],
            description: 'The log category level for calls to all system methods, such as the System.debug method.',
        }
    };

    private readonly noneTraceFlags: SalesforceDebugLevel = {
        apexCode: 'None',
        apexProfiling: 'None',
        callout: 'None',
        database: 'None',
        validation: 'Info',
        visualforce: 'None' ,
        workflow: 'None',
        system: 'None',
    };

    /**
     * Predefined log levels
     */
    private readonly traceFlagOptions : Array<vscode.QuickPickItem & { traceFlags?: SalesforceDebugLevel | null }> = [
        { label: 'User Debug', description: 'Only log user debug statements', traceFlags: { ...this.noneTraceFlags, apexCode: 'Debug' } },
        { label: 'User Debug with Limits', description: 'User debug statements and details on consumed govern limits', traceFlags: { ...this.noneTraceFlags, apexCode: 'Debug', apexProfiling: 'Finest' } },
        { label: 'User Debug with DML', description: 'User debug statements and executed DML', traceFlags: { ...this.noneTraceFlags, apexCode: 'Debug', database: 'Finest' } },
        { label: 'Fine', description: 'All log levels set to FINE', traceFlags: { ...this.noneTraceFlags, apexCode: 'Fine', apexProfiling: 'Fine', system: 'Fine', workflow: 'Fine', callout: 'Info', validation: 'Info', visualforce: 'Fine' } },
        { label: 'Finest', description: 'All log levels set to FINEST', traceFlags: { ...this.noneTraceFlags, apexCode: 'Finest', apexProfiling: 'Finest', system: 'Info', workflow: 'Finer', callout: 'Finest', validation: 'Info', visualforce: 'Finest' } },
        { label: 'Custom', description: 'Set your own trace flags' },
        { label: 'Clear/Disable', description: 'Clear trace flags and disable debug logging for the current user', traceFlags: null }
    ];

    private traceFlagsWatcherId: any;
    private currentTraceFlagsId: string;
    private readonly traceFlagsDuration = 300;

    /**
     * Clears all developer logs.
     */
    public async execute() {
        const traceFlagsSelection = await vscode.window.showQuickPick(this.traceFlagOptions, { placeHolder: 'Select Debug Level for logging...' });
        if (!traceFlagsSelection) {
            return;
        }

        let traceFlags = traceFlagsSelection.traceFlags;
        if (traceFlags === undefined) {
            traceFlags = await this.getCustomTraceFlags();
            if (!traceFlags) {
                return;
            }
        }

        if (this.traceFlagsWatcherId) {
            clearInterval(this.traceFlagsWatcherId);
        }

        return this.vlocode.withActivity({
            progressTitle: `Update log level: ${traceFlagsSelection.label}`,
            location: vscode.ProgressLocation.Notification,
            propagateExceptions: true,
            cancellable: false
        }, async () => {

            let debugLevelName = `Vlocode: ${traceFlagsSelection.label}`;
            const userInfo = await this.salesforce.getConnectedUserInfo();
            if (!traceFlagsSelection.traceFlags) {
                // custom flags are user-unique                
                debugLevelName += ` ${userInfo.id}`;
            }
            debugLevelName = debugLevelName.replace(/[^0-9a-z_]+/ig, '_');

            // Clear existing trace flags and stop extending them
            if (this.traceFlagsWatcherId !== undefined) {
                clearInterval(this.traceFlagsWatcherId);
            }
            await this.salesforce.clearUserTraceFlags();

            if (traceFlags) {
                const debugLevel = await this.salesforce.createDebugLevel(debugLevelName, traceFlags);
                this.currentTraceFlagsId = await this.salesforce.setTraceFlags(debugLevel, 'USER_DEBUG', undefined, this.traceFlagsDuration);
                void vscode.window.showInformationMessage(`Successfully updated Salesforce log levels to: ${traceFlagsSelection.label}`);

                // Keep trace flags active extend with 5 min each time; this esnures trace flags are removed once
                // vscode uis closed
                this.traceFlagsWatcherId = setInterval(this.traceFlagsWatcher.bind(this), (this.traceFlagsDuration - 60) * 1000);
            } else {
                void vscode.window.showInformationMessage(`Successfully cleared traceflags for ${userInfo.username}`);
            }
        });
    }

    public async getCustomTraceFlags(): Promise<SalesforceDebugLevel | undefined> {
        const traceFlags: any = {};
        for (const [field, info] of Object.entries(this.logLevelOptions)) {
            // Create options list
            const options = info.options.map(o => ({ label: o, isDefault: info.default === o }));
            const defaultIndex = options.findIndex(o => o.isDefault);
            if (defaultIndex >= 0) {
                options.unshift(...options.splice(defaultIndex, 1));
            }
            options[0] = { ...options[0], description: '(default)' };

            // Ask user to select any of the options from the list
            const selected = await vscode.window.showQuickPick(options, { placeHolder: `Select level for ${info.placeHolder}` });
            if (!selected) {
                return;
            }
            traceFlags[field] = selected.label;
        }
        return traceFlags;
    }

    public async traceFlagsWatcher() {
        if (this.currentTraceFlagsId) {
            this.logger.debug(`Extending active trace flags (${this.currentTraceFlagsId}) with ${this.traceFlagsDuration} seconds`);
            await this.salesforce.extendTraceFlags(this.currentTraceFlagsId, this.traceFlagsDuration);
        }
    }
}