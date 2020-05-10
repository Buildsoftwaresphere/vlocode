import * as jsforce from 'jsforce';
import * as xml2js from 'xml2js';
import * as constants from '@constants';
import JsForceConnectionProvider from 'lib/salesforce/connection/jsForceConnectionProvider';
import { stripPrefix, parseNumbers } from 'xml2js/lib/processors';
import axios from 'axios';
import SObjectRecord from 'lib/salesforce/sobjectRecord';
import Lazy from 'lib/util/lazy';
import cache from 'lib/util/cache';
import { LogManager, Logger } from 'lib/logging';
import SalesforceSchemaService from './salesforceSchemaService';
import SalesforceDeployService from './salesforceDeployService';
import QueryService from './queryService';

export interface InstalledPackageRecord extends jsforce.FileProperties {
    manageableState: string;
    namespacePrefix: string;
}

export interface OrganizationDetails {
    id: string;
    name: string;
    primaryContact: string;
    instanceName: string;
    isSandbox: boolean;
    organizationType: string;
    namespacePrefix: string;
}

interface ApexLogLevels {
    ApexCode: 'None' | 'Error' | 'Warn' | 'Info' | 'Debug' | 'Fine' | 'Finer' | 'Finest';
    ApexProfiling: 'None' | 'Info' | 'Fine' | 'Finest' ;
    Callout: 'None' | 'Info' | 'Finest';
    Database: 'None' | 'Info' | 'Finest';
    Validation: 'Info' | 'None';
    Visualforce: 'None' | 'Info' | 'Fine' | 'Finest' ;
    Workflow: 'None' | 'Error' | 'Warn' | 'Info' |  'Fine' | 'Finer' ;    
    System: 'None' | 'Info' | 'Debug' | 'Fine' ;
}

type SoapDebuggingLevel = 'NONE' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'FINE' | 'FINER' | 'FINEST';
export type SoapDebuggingHeader = {
    Db?: SoapDebuggingLevel
    Workflow?: SoapDebuggingLevel
    Validation?: SoapDebuggingLevel
    Callout?: SoapDebuggingLevel
    Apex_code?: SoapDebuggingLevel
    Apex_profiling?: SoapDebuggingLevel
    Visualforce?: SoapDebuggingLevel
    System?: SoapDebuggingLevel
    All?: SoapDebuggingLevel
};


export type PropertyAccessor = string | number | symbol;

export type QueryResult<TBase, TProps extends PropertyAccessor = any> = TBase & Partial<SObjectRecord> & { [P in TProps]: any; };


/**
 * Simple Salesforce SOAP request formatter
 */
class SoapRequest {
    
    constructor(
        public readonly method : string, 
        public readonly namespace : string, 
        public readonly debuggingHeader: SoapDebuggingHeader = {}) {        
    }

    /**
     * Converts the contents of the package to XML that can be saved into a package.xml file
     */
    public toXml(requestBody: Object, sessionId: string) : string {
        const soapRequestObject = { 
            'soap:Envelope': {
                $: {
                    "xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/",
                    "xmlns": this.namespace
                },
                'soap:Header': {
                    CallOptions: {
                        client: constants.API_CLIENT_NAME
                    },
                    DebuggingHeader: {
                        categories: Object.entries(this.debuggingHeader).map(([category, level]) => ({ category, level }))
                    },
                    SessionHeader: {
                        sessionId: sessionId
                    }
                },
                'soap:Body': {
                    [this.method]: requestBody,
                }
            }
        }; 
        return new xml2js.Builder(constants.MD_XML_OPTIONS).buildObject(soapRequestObject);
    }
}

/**
 * Simple SOAP response
 */
interface SoapResponse { 
    Envelope: {
        Header?: any,
        Body?: {
            Fault?: {
                faultcode: string,
                faultstring: string
            },
            [key: string]: any
        }
    };
 }

export default class SalesforceService implements JsForceConnectionProvider {  

    private readonly vlocityNamespace = new Lazy(() => this.getInstalledPackageNamespace(/vlocity/i));
    
    public readonly schema = new SalesforceSchemaService(this.connectionProvider);
    public readonly deploy = new SalesforceDeployService(this);
    
    constructor(
        private readonly connectionProvider: JsForceConnectionProvider, 
        private readonly queryService = new QueryService(connectionProvider),
        private readonly logger = LogManager.get(SalesforceService)) {
    }

    public async isProductionOrg() : Promise<boolean> {
        return (await this.getOrganizationDetails()).isSandbox !== true;
    }

    public getJsForceConnection() : Promise<jsforce.Connection> {
        return this.connectionProvider.getJsForceConnection();
    }

    public async isPackageInstalled(packageName: string | RegExp) : Promise<boolean> {
        return (await this.getInstalledPackageDetails(packageName)) !== undefined;
    }

    public async getPageUrl(page : string, ops?: { namespacePrefix? : string, useFrontdoor?: boolean}) {
        const con = await this.getJsForceConnection();
        let relativeUrl = page.replace(/^\/+/, '');
        if (relativeUrl.startsWith('apex/')) {
            // build lightning URL
            const state = { 
                componentDef: 'one:alohaPage', 
                attributes: {
                    address: `${con.instanceUrl}/${relativeUrl}`
                },
                state: { }
            };
            relativeUrl = 'one/one.app#' + Buffer.from(JSON.stringify(state)).toString('base64');
        }
        if (ops?.useFrontdoor) {
            relativeUrl = `secur/frontdoor.jsp?sid=${encodeURIComponent(con.accessToken)}&retURL=${encodeURIComponent(relativeUrl)}`;
        }
        const urlNamespace = ops?.namespacePrefix ? '--' + ops.namespacePrefix.replace(/_/i, '-') : '';
        return con.instanceUrl.replace(/(http(s|):\/\/)([^.]+)(.*)/i, `$1$3${urlNamespace}$4/${relativeUrl}`);
    }


    @cache(-1)
    public async getInstalledPackageNamespace(packageName: string | RegExp) : Promise<string> {
        const installedPackage = await this.getInstalledPackageDetails(packageName);
        if (!installedPackage) {
            throw new Error(`Package with name ${packageName} is not installed on your Salesforce organization`);
        }
        return installedPackage.namespacePrefix;
    }

    @cache(-1)
    public async getInstalledPackageDetails(packageName: string | RegExp) : Promise<InstalledPackageRecord | undefined> {
        const results = await this.getInstalledPackages();     
        return results.find(packageInfo => typeof packageName === 'string' ? packageName == packageInfo.fullName : packageName.test(packageInfo.fullName));
    }

    @cache(-1)
    public async getInstalledPackages() : Promise<InstalledPackageRecord[]> {
        const con = await this.getJsForceConnection();
        return con.metadata.list( { type: 'InstalledPackage' }) as Promise<InstalledPackageRecord[]>;
    }

    @cache(-1)
    public async getOrganizationDetails() : Promise<OrganizationDetails> {
        const results = await this.query<OrganizationDetails>('SELECT Id, Name, PrimaryContact, IsSandbox, InstanceName, OrganizationType, NamespacePrefix FROM Organization');
        return results[0];
    }

    /**
     * Returns a list of records. All records are mapped to record proxy object 
     * @param query SOQL Query to execute
     */
    public async query<T extends Partial<SObjectRecord>>(query: string) : Promise<T[]> {
        return this.queryService.query(
            query.replace(constants.NAMESPACE_PLACEHOLDER, await this.vlocityNamespace)
        );
    }

    private async soapToolingRequest(methodName: string, request: object, debuggingHeader?: SoapDebuggingHeader) : Promise<{ body?: any, debugLog?: any }> {
        const connection = await this.getJsForceConnection();
        const soapRequest = new SoapRequest(methodName, "http://soap.sforce.com/2006/08/apex", debuggingHeader);
        const endpoint = `${connection.instanceUrl}/services/Soap/s/${connection.version}`;
        const result = await axios({
            method: 'POST',
            url: endpoint,
            headers: {
                'SOAPAction': '""',
                'Content-Type':  'text/xml;charset=UTF-8'
            },
            transformResponse: (data: any, headers?: any) => {
                return xml2js.parseStringPromise(data, {
                    tagNameProcessors: [ stripPrefix ],            
                    attrNameProcessors: [ stripPrefix ],
                    valueProcessors: [
                        (value) => {
                            if (/^[0-9]+(\.[0-9]+){0,1}$/i.test(value)) {
                                return parseFloat(value);
                            } else if (/^true|false$/i.test(value)) {
                                return value.localeCompare('true', undefined, { sensitivity: 'base' }) === 0;
                            }
                            return value;
                        }
                    ],
                    explicitArray: false
                });
            },
            data: soapRequest.toXml(request, connection.accessToken)
        });        
        const response = <SoapResponse>(await result.data);

        if (response.Envelope.Body?.Fault) {
            throw new Error(`SOAP API Fault: ${response.Envelope.Body.Fault?.faultstring}`);
        }

        return {
            body: response.Envelope.Body,
            debugLog: response.Envelope?.Header?.DebuggingInfo.debugLog,
        };
    }

    /**
     * Executes the specified APEX using the SOAP API and returns the result.
     * @param apex APEX code to execute
     * @param logLevels Optional debug log levels to use
     */
    public async executeAnonymous(apex: string, logLevels?: SoapDebuggingHeader) : Promise<jsforce.ExecuteAnonymousResult & { debugLog?: string }> {
        const response = await this.soapToolingRequest('executeAnonymous', {
            String: apex
        }, logLevels);
        return {
            ...response.body.executeAnonymousResponse.result,
            debugLog: response.debugLog
        };
    }

    /**
     * Compiles the specified class bodies on the server
     * @param apexClassBody APEX classes to compile
     */
    public async compileClasses(apexClassBody: string[]) : Promise<any> {
        const response = await this.soapToolingRequest('compileClasses', {
            scripts: apexClassBody
        });
        return {
            ...response.body.compileClassesResponse
        };
    }
    
    /**
     * Get a list of available API version on the connected server
     */
    @cache(-1)
    public async getApiVersions(count: number = 10) {
        const connection = await this.getJsForceConnection();
        const version = parseFloat(connection.version);
        const versions = [];
        for (let i = 0; i < count; i++) {
            versions.push((version - i).toFixed(1));
        }
        return versions;
    }

    // public async getDeveloperLogs(numberOfLogs = 10) {
    //     const connection = await this.getJsForceConnection();
    //     const selectFields = ['Id', 'Application', 'DurationMilliseconds', 'Location', 'LogLength', 'LogUser.Name', 'Operation', 'Request', 'StartTime', 'Status' ];
    //     const toolingQuery = `Select ${selectFields.join(',')} From ApexLog Order By StartTime${numberOfLogs ? ` DESC LIMIT ${numberOfLogs}` : ''}`;
    //     const toolingUrl = `${connection.instanceUrl}/services/data/v${connection.version}/tooling/query/?q=${toolingQuery.replace(' ', '+')}`;
    //     const results1 = await connection.tooling.query(toolingQuery);
    //     const results2 = <any>await connection.request(toolingQuery);
    //     return results2?.records;
    // }

    // public async setLogLevel(name: string, logLevels: ApexLogLevels) {
    //     connection.tooling.create('traceFlag', records)
    //     const connection = await this.getJsForceConnection();
    //     const selectFields = ['Id', 'Application', 'DurationMilliseconds', 'Location', 'LogLength', 'LogUser.Name', 'Operation', 'Request', 'StartTime', 'Status' ];
    //     const toolingQuery = `Select ${selectFields.join(',')} From ApexLog Order By StartTime${numberOfLogs ? ` DESC LIMIT ${numberOfLogs}` : ''}`;
    //     const toolingUrl = `${connection.instanceUrl}/services/data/v${connection.version}/tooling/query/?q=${toolingQuery.replace(' ', '+')}`;
    //     const results1 = await connection.tooling.query(toolingQuery);
    //     const results2 = <any>await connection.request(toolingQuery);
    //     return results2?.records;
    // }
}