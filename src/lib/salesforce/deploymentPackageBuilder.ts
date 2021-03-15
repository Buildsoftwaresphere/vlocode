import * as path from 'path';
import * as fs from 'fs-extra';
import * as jsforce from 'jsforce';
import { Logger } from 'lib/logging';
import { getDocumentBodyAsString } from 'lib/util/fs';
import * as vscode from 'vscode';
import { stringEquals, substringAfterLast } from 'lib/util/string';
import SalesforceService from './salesforceService';
import { MetadataObject } from 'jsforce';
import { SalesforcePackage } from './deploymentPackage';
import * as xml2js from 'xml2js';
import * as constants from '@constants';
import { asArray } from 'lib/util/collection';
import { service } from 'lib/core/inject';
import { LifecyclePolicy } from 'lib/core/container';
import { PackageManifest } from './deploy/packageXml';

export enum SalesforcePackageType {
    /**
     * Deploy all files in the package
     */
    deploy = 'deploy',
    /**
     * Build a package without adding data.
     */
    retrieve = 'retrieve',
    /**
     * Build package as destructive change; files added inthe builder will be removed from the target org
     */
    destruct = 'destruct',
}

@service({ lifecycle: LifecyclePolicy.transient })
export class SalesforcePackageBuilder {

    private mdPackage: SalesforcePackage;
    constructor(apiVersion: string, type: SalesforcePackageType, ...args: any[]);
    constructor(
        public readonly apiVersion: string,
        public readonly type: SalesforcePackageType,
        private readonly salesforce: SalesforceService,
        private readonly logger: Logger) {
        this.mdPackage = new SalesforcePackage(apiVersion);
    }

    /**
     * Adds one or more files to the package.
     * @param files Array of files to add
     * @param token Optional cancellation token
     * @returns Instance of the package builder.
     */
    public async addFiles(files: vscode.Uri[], token?: vscode.CancellationToken) : Promise<this> {
        // Build zip archive for all expanded files
        // Note use posix path separators when building package.zip
        for (const file of files) {

            // Stop directly and return null
            if (token && token.isCancellationRequested) {
                break;
            }

            // parse folders recusively
            if ((await vscode.workspace.fs.stat(file)).type == vscode.FileType.Directory) {
                await this.addFiles((await vscode.workspace.fs.readDirectory(file)).map(([f]) => vscode.Uri.joinPath(file, f)), token);
                continue;
            }

            // If selected file is a meta file check the source file instead
            const isMetaFile = file.fsPath.endsWith('-meta.xml');
            if (isMetaFile) {
                const sourceFile = file.with({ path: file.path.slice(0, -9) });
                if ((await vscode.workspace.fs.stat(sourceFile))) {
                    await this.addFiles([ sourceFile ], token);
                }
            }

            // get metadata type
            const xmlName = await this.getXmlName(file);
            const metadataType = xmlName && await this.getMetadataType(xmlName);
            if (!xmlName || !metadataType) {
                this.logger.debug(`Adding ${file} is not a known Salesforce metadata type`);
                continue;
            }

            if (metadataType.xmlName != xmlName) {
                // Support for SFDX formatted source code
                this.mergeChildSourceWithParent(file, xmlName, metadataType);
                continue;
            }

            const isBundle = xmlName.endsWith('Bundle');
            const packageFolder = this.getPackageFolder(file.fsPath, metadataType);
            const componentName = this.getPackageComponentName(file.fsPath, metadataType);
            
            if (isBundle) {
                // Only Aura and LWC are bundled at this moment
                // Classic metadata package all related files
                const sourceFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(path.dirname(file.fsPath), '**'));
                for (const sourceFile of sourceFiles) {
                    const packagePath = path.posix.join(packageFolder, path.basename(sourceFile.fsPath));
                    this.logger.verbose(`Adding ${path.basename(sourceFile.fsPath)} as ${xmlName} (bundle)`);
                    this.mdPackage.add({xmlName, componentName, packagePath, fsPath: sourceFile.fsPath });
                }
            } else {
                // add source
                const packagePath = path.posix.join(packageFolder, path.basename(file.fsPath));
                this.logger.verbose(`Adding ${path.basename(file.fsPath)} as ${xmlName}`);
                
                // Try merging with existing metadata -- otherwise add as new
                if (!await this.mergeWithExistingMetadata(packagePath, file, metadataType)) {                       
                    this.mdPackage.add({xmlName, componentName, packagePath, fsPath: file.fsPath });
                }
            }
        }

        return this;
    }

    /**
     * Merge the source of the child element into the parent
     * @param sourceFile Source file containing the child source
     * @param xmlName XML name of the child element
     * @param metadataType Metadata type of the parent/root
     */
    private async mergeChildSourceWithParent(sourceFile: vscode.Uri, xmlName: string, metadataType: jsforce.MetadataObject) {
        // Get metadata type for a source file
        const tagNameInParent = substringAfterLast(path.dirname(sourceFile.fsPath), /\\|\//);
        const chilComponentName = this.getPackageComponentName(sourceFile.fsPath, metadataType);
        const childMetadata = (await xml2js.parseStringPromise(await getDocumentBodyAsString(sourceFile)))[xmlName];

        const parentComponentFolder = path.join(...sourceFile.fsPath.split(/\\|\//g).slice(0,-2));
        const parentComponentName = path.basename(parentComponentFolder);   
        const parentComponentMetaFile =  path.join(parentComponentFolder, `${parentComponentName}.${metadataType.suffix}-meta.xml`);
        const parentPackagePath = this.getPackagePath(parentComponentMetaFile, metadataType);
        const parentPackageData = await this.mdPackage.getPackageData(parentPackagePath);
        const parentMetadata = parentPackageData ? await xml2js.parseStringPromise(parentPackageData)[metadataType.xmlName] : {};

        // Merge child metadata into parent metadata 
        const mergedMetadata = this.mergeMetadata(parentMetadata, { [tagNameInParent]: childMetadata });
        if (this.type == SalesforcePackageType.deploy) {
            this.mdPackage.addPackageData(parentPackagePath, { data: this.buildMetadataXml(metadataType.xmlName, mergedMetadata) });
        }

        // Add as member to the package when not yet mentioned
        this.mdPackage.addPackageMember(metadataType.xmlName, parentComponentName);
        this.mdPackage.addPackageMember(xmlName, `${parentComponentName}.${chilComponentName}`);

        this.logger.verbose(`Adding ${path.basename(sourceFile.fsPath)} as ${parentComponentName}.${chilComponentName}`);
    }

    /**
     * Merge the source file into the existing package metadata when there is an existing metadata file.
     * @param packagePath Relative path of the source file in the package
     * @param fileToMerge Path of the metedata file to merge into the existing package file
     * @param metadataType Type of metadata to merge
     * @returns true if the file is merged otherwise false.
     */
    private async mergeWithExistingMetadata(packagePath: string, sourceFile: vscode.Uri, metadataType: jsforce.MetadataObject) {
        const existingPackageData = await this.mdPackage.getPackageData(packagePath);
        if (!existingPackageData) {
            return false;
        }

        const existingMetadata = await xml2js.parseStringPromise(existingPackageData);
        const newMetadata = await xml2js.parseStringPromise(await getDocumentBodyAsString(sourceFile));
        const mergedMetadata = this.mergeMetadata(existingMetadata[metadataType.xmlName], newMetadata[metadataType.xmlName]);
        this.mdPackage.addPackageData(packagePath, { data: this.buildMetadataXml(metadataType.xmlName, mergedMetadata), fsPath: sourceFile.fsPath});
        return true;
    }

    //  private async addEmbeddedMetadataMembers(sourceFile: vscode.Uri, metadataType: jsforce.MetadataObject) {
    //     const metadata = await xml2js.parseStringPromise(await getDocumentBodyAsString(sourceFile));
    //     for(const [key, value] of Object.entries(metadata[metadataType.xmlName])) {
    //         //const isChildElement = 
    //         if (typeof value === 'object') {
    //             for (const child of asArray(value)) {
                    
    //             }
    //         }
    //     }
    // }

    private mergeMetadata(targetMetadata: object, sourceMetdata: object) {
        for (let [key, value] of Object.entries(sourceMetdata)) {
            if (value === undefined) {
                continue; // skip undefined
            }

            if (typeof value === 'object' && !Array.isArray(value)) {
                value = [ value ];
            }

            let existingValue = targetMetadata[key];
            if (!existingValue) {
                targetMetadata[key] = value;
            } else if (Array.isArray(value)) {
                if (Array.isArray(existingValue)) {
                    existingValue.push(...value);
                } else if (typeof targetMetadata === 'object') {
                    targetMetadata[key] = [ targetMetadata[key], ...value ];
                } else {
                    throw new Error(`Cannot merge metadata; properties of the source and target metadata are incompatible for property ${key}: expected source to be an Object or Array `);
                }
            }
        }
        return targetMetadata;
    }

    /**
     * Gets SalesforcePackage underlying the builder.
     */
    public getPackage(): SalesforcePackage {
        this.mdPackage.generateMissingMetaFiles();
        return this.mdPackage;
    }

     /**
     * Gets SalesforcePackage underlying the builder.
     */
      public getManifest(): PackageManifest {
        this.mdPackage.generateMissingMetaFiles();
        return this.mdPackage.manifest;
    }

    private async getMetadataType(xmlName: string) {
        const metadataTypes = await this.salesforce.getMetadataTypes();
        return metadataTypes.metadataObjects.find(type => type.xmlName == xmlName || type.childXmlNames?.includes(xmlName));
    }

    private async getXmlName(file: vscode.Uri) {
        const metadataTypes = await this.salesforce.getMetadataTypes();
        const fileLowerCase = file.fsPath.toLowerCase();

        if (fileLowerCase.endsWith('.xml')) {
            let xmlName = await this.getRootElementName(file);

            // Cannot detect certain metadata types properly so instead manually set the type
            if (xmlName == 'EmailFolder') {
                xmlName = 'EmailTemplate';
            } else if (xmlName && xmlName.endsWith('Folder')) {
                // Handles document Folder and otehr folder cases
                xmlName = xmlName.substr(0, xmlName.length - 6);
            }

            const metadataType = xmlName && metadataTypes.metadataObjects.find(type => type.xmlName == xmlName || type.childXmlNames?.includes(xmlName!));
            if (metadataType) {
                return xmlName;
            }
        }

        const directoryNameOnlyMatches = new Array<string>();
        for (const type of metadataTypes.metadataObjects) {
            const suffixMatches = type.suffix && fileLowerCase.endsWith(`.${type.suffix.toLowerCase()}`);
            const metaSuffixMatches = type.suffix && type.metaFile && fileLowerCase.endsWith(`.${type.suffix.toLowerCase()}-meta.xml`);
            const directoryNameMatches = type.directoryName && path.dirname(file.fsPath).split(/[\/\\]/g).some(dirname => stringEquals(dirname, type.directoryName));

            if (metaSuffixMatches) {
                return type.xmlName;
            }

            if (suffixMatches) {
                if (type.metaFile && fs.existsSync(`${file.fsPath}-meta.xml`)) {
                    return type.xmlName;
                }
                
                if (directoryNameMatches) {
                    return type.xmlName;
                }
            }

            if (directoryNameMatches) {
                // Matches aura and lwc bundled files primarly
                directoryNameOnlyMatches.push(type.xmlName);
            }
        }

        if (directoryNameOnlyMatches.length == 1) {
            return directoryNameOnlyMatches.pop();
        }
    }

    /**
     * Get root Element/Tag name of the specified XML file.
     * @param file Path to the XML file from which to get the root element name.
     */
     private async getRootElementName(file: vscode.Uri) {
        const body = await getDocumentBodyAsString(file);
        try {
            return Object.keys(await xml2js.parseStringPromise(body)).shift();
        } catch{
            return undefined;
        }        
    }

    /**
     * Gets the name of the component for the package manifest
     * @param metaFile 
     * @param metadataType 
     */
    private getPackageComponentName(metaFile: string, metadataType: MetadataObject) : string {
        const sourceFileName = path.basename(metaFile).replace(/-meta\.xml$/ig, '');
        const componentName = sourceFileName.replace(/\.[^.]+$/ig, '');
        const packageFolder = this.getPackageFolder(metaFile, metadataType);
        const isBundle = metadataType.xmlName.endsWith('Bundle');

        if (isBundle) {
            return metaFile.split(/\\|\//g).slice(-2).shift()!;
        }

        if (packageFolder.includes(path.posix.sep)) {
            return packageFolder.split(path.posix.sep).slice(1).concat([ componentName ]).join(path.posix.sep);
        }

        return componentName;
    }

    /**
     * Get the packaging folder for the source file.
     * @param fullSourcePath 
     * @param metadataType 
     */
    private getPackageFolder(fullSourcePath: string, metadataType: MetadataObject) : string {
        const retainFolderStructure = !!metadataType.inFolder;
        const componentPackageFolder = metadataType.directoryName;

        if (retainFolderStructure && componentPackageFolder) {
            const packageParts = path.dirname(fullSourcePath).split(/\/|\\/g);
            const packageFolderIndex = packageParts.indexOf(componentPackageFolder);
            return packageParts.slice(packageFolderIndex).join(path.posix.sep);
        }

        return componentPackageFolder ?? substringAfterLast(path.dirname(fullSourcePath), /\/|\\/g);
    }

    private getPackagePath(sourceFile: string, metadataType: MetadataObject) {        
        return path.posix.join(this.getPackageFolder(sourceFile, metadataType), path.basename(sourceFile));
    }

    private buildMetadataXml(rootName: string, data?: any) {
        const xmlBuilder = new xml2js.Builder(constants.MD_XML_OPTIONS);
        return xmlBuilder.buildObject({
            [rootName]: {
                $: { xmlns: 'http://soap.sforce.com/2006/04/metadata' },
                ...(data || {})
            }
        });
    }
}