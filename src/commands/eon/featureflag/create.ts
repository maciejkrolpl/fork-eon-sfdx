/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { SfdxCommand } from '@salesforce/command';
import {
  Messages,
  NamedPackageDir,
  SfdxError,
  SfdxProjectJson
} from '@salesforce/core';
import {
  ComponentSet,
  MetadataApiDeploy
} from '@salesforce/source-deploy-retrieve';
import { AnyJson, toAnyJson } from '@salesforce/ts-types';
import fs from 'fs/promises';
import * as os from 'os';
import { PluginSettings } from '../../../helper/types';
import chalk from 'chalk';
// @ts-ignore
import { AutoComplete, Input, Select, Toggle } from 'enquirer';
import path from 'path';
import EONLogger, { COLOR_HEADER, COLOR_WARNING } from '../../../eon/EONLogger';
import { LOGOBANNER } from '../../../eon/logo';
import {
  MetadataFile,
  PathItem,
  getCategoriesItemsSet,
  getFeatureFlagComponents,
  getPermsetWithPaths,
  readCategoriesFromFFs,
  readLabelsFromFFs
} from '../../../helper/featureflags';
import { getParentPackages } from '../../../helper/get-packages';
import { addCustomPermission } from '../../../helper/package-custompermission';
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@eon-com/eon-sfdx', 'featureflags');

export default class Create extends SfdxCommand {

  private CATEGORY_ANSWER = {
    GO_BACK: chalk.dim(' - (go one level back)'),
    ADD_NEW: chalk.dim(' + (add new entry)'),
    SAVE_NOW: chalk.dim(' * (finish entering category)')
  };

  private TYPE = {
    CUSTOM_SETTING: 'Custom Setting',
    CUSTOM_PERMISSION: 'Custom Permission'
  }

  private REGEX = {
    APINAME_VALIDATE: /(^[^a-z].*$|^.*_$|^.*__.*$|[^a-z0-9_])/i,
    SPLIT_WITH_SPACES: /(\S+(\s\S+)?)( {2,})(\S+(\s\S+)?|\S+)/
  }

  private PERMSET_OPTION = {
    ADD: 'Add to existing',
    NEW: 'Create a new one',
    SKIP: 'skip'
  }

  public static args = [{ name: 'file' }];

  protected static requiresProject = true;
  protected static requiresUsername = true;

  public static description = messages.getMessage('commandDescription');
  public static examples = messages.getMessage('examples').split(os.EOL);

  private categoriesItemsSet: string[];
  private featureFlagLabels: string[];
  private categoriesTree: object;
  private projectJson: SfdxProjectJson;
  private packageDirs: NamedPackageDir[];
  private sourceSubdir: string;
  private customSettingsObject: string;

  private async checkCustomSettingsInstanceExists(): Promise<Boolean> {
    interface Settings {
      Id?: string;
      [key: string]: any;
    }
    const conn = this.org.getConnection();
    const query = `select id,  SetupOwnerId from ${this.customSettingsObject}__c`;
    const result = await conn.query<Settings>(query);
    const queryRes = result.records.find((record) => record.SetupOwnerId.substring(0, 3) == '00D');
    return !!queryRes;
  }

  private async createCustomSettingsInstance(name: string): Promise<void> {
    this.ux.startSpinner('Setting does not exist yet. Initializing new...');
    const conn = this.org.getConnection();
    const newRecord = { [`${name}__c`]: false };
    const newSetting = await conn.sobject(`${this.customSettingsObject}__c`).create(newRecord);
    if (!newSetting.success) {
      this.ux.stopSpinner(`Update not successfully. Please try again`);
    } else {
      this.ux.stopSpinner(`update custom settings successfully`);
    }
  }

  private getEntries(categoriesTree: object, path: Array<PathItem>) {
    let tempObj = categoriesTree;
    if (path.length) {
      for (const entry of path) {
        if (entry.isCustom === false && tempObj[entry.name]) {
          tempObj = tempObj[entry.name]
        } else {
          return [];
        }
      }
    }
    return Object.keys(tempObj)
  }

  private getDisplayChoices(choices: Array<string>, level: number): string[] {
    return [
      ...(choices.length > 0 ? [...choices] : [this.CATEGORY_ANSWER.SAVE_NOW]),
      ...(level > 1 ? [this.CATEGORY_ANSWER.GO_BACK] : []),
      ...[this.CATEGORY_ANSWER.ADD_NEW]
    ];
  }

  private async getCategoryFromUser(): Promise<string> {
    let isChoiceMade = false;
    let choicePath: Array<PathItem> = [];
    let choices = this.getEntries(this.categoriesTree, choicePath);

    while (!isChoiceMade) {
      const level = choicePath.length + 1;
      const displayChoices = this.getDisplayChoices(choices, level);
      console.clear();

      let message: string;
      if (level === 0) {
        message = 'Add new entry or finish entering category';
      } else if (level === 1) {
        message = 'Select top-level category'
      } else {
        message = `Select subcategory\nYour choices: ${choicePath.map(item => item.name).join(' => ')} => `;
      }

      const prompt = new AutoComplete({
        name: `level${level}`,
        message,
        limit: 15,
        choices: displayChoices
      })

      let answer: string;
      try {
        answer = await prompt.run();
      } catch (error) {
        console.error('🚀', error);
      }

      if (answer === this.CATEGORY_ANSWER.GO_BACK) {
        const lastItem = choicePath.pop();
        if (lastItem.isCustom) {
          this.categoriesItemsSet = this.categoriesItemsSet.filter(setItem => setItem !== lastItem.name)
        }
      } else if (answer === this.CATEGORY_ANSWER.ADD_NEW) {
        let newItem: string;
        let isItemUnique: boolean;
        do {
          const newItemPrompt = new Input({
            message: 'Enter new category item'
          });

          newItem = await newItemPrompt.run();
          isItemUnique = !(this.categoriesItemsSet.includes(newItem));
          if (!isItemUnique) {
            EONLogger.log(COLOR_WARNING('Category item must be unique!'));
          }
        } while (!isItemUnique)
        choicePath.push({ name: newItem, isCustom: true });
        this.categoriesItemsSet.push(newItem)

      } else if (answer === this.CATEGORY_ANSWER.SAVE_NOW) {
        isChoiceMade = true;
      }
      else {
        choicePath.push({ name: answer, isCustom: false });
      }
      choices = this.getEntries(this.categoriesTree, choicePath);
    }

    return choicePath.map(c => c.name).join('.');

  }

  private async handlePermissionSet({ name, packageName }): Promise<MetadataFile> {
    const handlePermSet = await new Select({
      name: 'handlePermSet',
      message: 'Do you want to add Custom Permission to existing Permission Set or create a new one?',
      choices: Object.values(this.PERMSET_OPTION)
    }).run();

    if (handlePermSet === this.PERMSET_OPTION.SKIP) {
      return null;
    }

    const availablePackages = await getParentPackages(this.projectJson, packageName, true);

    if (handlePermSet === this.PERMSET_OPTION.ADD) {
      return await this.addToPermissionSet({ name, availablePackages });
    } else if (handlePermSet === this.PERMSET_OPTION.NEW) {
      return await this.createPermissionSet({ name, packageName });
    }
  }

  private convertLabelToApiName(label: string): string {
    let name = label
      .replace(/^[^a-zA-Z0-9_]|[^a-zA-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!/^[a-zA-Z]/.test(name)) {
      name = "X" + name;
    }
    return name;
  }

  private async createPermissionSet({ name, packageName }): Promise<MetadataFile> {
    const psLabel = await new Input({
      name: 'Label',
      message: 'Enter Permission Set Label'
    }).run();

    const defaultName = this.convertLabelToApiName(psLabel);

    const psName = await new Input({
      name: 'Name',
      message: 'Enter Feature Label (enter to confirm default)',
      initial: defaultName,
      validate: (value: string) => {
        if (this.REGEX.APINAME_VALIDATE.test(value)) {
          return chalk.red(`The API name must begin with a letter and use only alphanumeric characters and underscores. It can't include spaces, end with an underscore, or have two consecutive underscores.`)
        }
        return true;
      }
    }).run();

    const packageDir = this.getPackagesAbsolutePath(packageName);
    return this.generatePermissionSetWithCustomPermission({ psName, psLabel, packageDir, cpName: name })
  }

  private async addToPermissionSet({ name, availablePackages }): Promise<MetadataFile> {

    let allPermsets = []
    for (const pkg of availablePackages) {
      try {
        const pkgPermsets = await getPermsetWithPaths(pkg);
        allPermsets = [...allPermsets, ...pkgPermsets];
      } catch (error) {
        console.error(error);
      }
    }

    allPermsets.sort((a, b) => a.label.localeCompare(b.label));
    const maxLength = allPermsets.reduce((max, ps) => Math.max(max, ps.label.length), 0);
    const choices = allPermsets.map(ps => {
      const spaces = ' '.repeat(maxLength - ps.label.length + 2);
      return `${ps.label}${spaces}${ps.package}`
    })
    const messageLine2 = `PermSet${' '.repeat(maxLength - 5)}package`;

    const prompt = await new AutoComplete({
      name: 'SelectedPermset',
      message: 'Select Permission Set. ' + chalk.dim('Displayed are Permission Sets from related packages, if you want to add Permission Set from another package, update sfdx-config.json first.\n' + messageLine2),
      limit: 15,
      choices
    })

    let selectedPermsetLabel: string;
    let selectedPermsetPkg: string;
    try {
      const answer = await prompt.run();
      const match = answer.match(this.REGEX.SPLIT_WITH_SPACES);
      selectedPermsetLabel = match[1];
      selectedPermsetPkg = match[4]
    } catch (error) {
      console.error('🚀', error);
    }

    const selectedPermSet = allPermsets.find(ps => ps.label === selectedPermsetLabel);
    const newContent = addCustomPermission(selectedPermSet.content, name);
    selectedPermSet.content = newContent;

    const content = selectedPermSet.content;
    const dirPath = `${this.getPackagesAbsolutePath(selectedPermSet.package)}permissionsets\\`;
    const fileName = path.basename(selectedPermSet.path);
    const filePath = `${dirPath}${fileName}`;

    return { content, dirPath, filePath } as MetadataFile;
  }

  private generatePermissionSetWithCustomPermission({ psName, psLabel, cpName, packageDir }): MetadataFile {
    let content = '<?xml version="1.0" encoding="UTF-8"?>\n';
    content += '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    content += '    <customPermissions>\n';
    content += '        <enabled>true</enabled>\n';
    content += `        <name>${cpName}</name>\n`;
    content += '    </customPermissions>\n';
    content += '    <hasActivationRequired>false</hasActivationRequired>\n';
    content += `    <label>${psLabel}</label>\n`;
    content += '    <license>Salesforce</license>\n';
    content += '</PermissionSet>\n';
    const dirPath = `${packageDir}permissionsets\\`;
    const filePath = `${dirPath}${psName}.permissionset-meta.xml`;
    return { content, dirPath, filePath };

  }

  private generateCustomSettingField({ object, name, label, packageDir }): MetadataFile {
    let content = '<?xml version="1.0" encoding="UTF-8"?>\n';
    content += '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    content += `    <fullName>${name}__c</fullName>\n`;
    content += '    <defaultValue>false</defaultValue>\n';
    content += '    <externalId>false</externalId>\n';
    content += `    <label>${label}</label>\n`;
    content += '    <trackTrending>false</trackTrending>\n';
    content += '    <type>Checkbox</type>\n';
    content += '</CustomField>';
    const dirPath = `${packageDir}objects\\${object}__c\\fields\\`
    const filePath = `${dirPath}${name}__c.field-meta.xml`;
    return { content, dirPath, filePath };
  }

  private generateCustomMetadataRecord({ label, object, category, type, name, packageDir }): MetadataFile {
    let content = '<?xml version="1.0" encoding="UTF-8"?>\n';
    content += '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n';
    content += `    <label>${label}</label>\n`;
    content += '    <protected>false</protected>\n';
    content += '    <values>\n';
    content += '        <field>Category__c</field>\n';
    content += `        <value xsi:type="xsd:string">${category}</value>\n`;
    content += '    </values>\n';
    content += '    <values>\n';
    content += '        <field>Setting__c</field>\n';
    content += `        <value xsi:type="xsd:string">${object}__c.${name}__c</value>\n`;
    content += '    </values>\n';
    content += '    <values>\n';
    content += '        <field>Type__c</field>\n';
    content += `        <value xsi:type="xsd:string">${type}</value>\n`;
    content += '    </values>\n';
    content += '</CustomMetadata>';
    const dirPath = `${packageDir}customMetadata\\`;
    const filePath = `${dirPath}Feature_Flag.${name}.md-meta.xml`;
    return { content, filePath, dirPath };
  }

  private generateCustomSettingsObject({ object, defaultDir }): MetadataFile {
    let content = '<?xml version="1.0" encoding="UTF-8"?>\n';
    content += '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    content += '    <customSettingsType>Hierarchy</customSettingsType>\n';
    content += '    <enableFeeds>false</enableFeeds>\n';
    content += `    <label>${object}</label>\n`;
    content += '    <visibility>Public</visibility>\n';
    content += '</CustomObject>\n';
    const dirPath = `${defaultDir}objects\\${object}__c\\`;
    const filePath = `${dirPath}${object}__c.object-meta.xml`;
    return { content, filePath, dirPath };
  }

  private generateCustomPermission({ label, name, packageDir }): MetadataFile {
    let content = '<?xml version="1.0" encoding="UTF-8"?>\n';
    content += '<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    content += '    <isLicensed>false</isLicensed>\n';
    content += `    <label>${label}</label>\n`;
    content += '</CustomPermission>\n';
    const dirPath = `${packageDir}customPermissions\\`;
    const filePath = `${dirPath}${name}.customPermission-meta.xml`;
    return { content, dirPath, filePath };
  }

  private async deployFeatureFlag({ object, name, sourcesToDeploy, type }) {

    const deploy: MetadataApiDeploy = await ComponentSet.fromSource(sourcesToDeploy).deploy({
      usernameOrConnection: this.org.getConnection().getUsername(),
    });
    this.ux.startSpinner('Deploying...');
    deploy.onUpdate((response) => {
      const { status } = response;
      this.ux.setSpinnerStatus(status);
    });

    const deployRes = await deploy.pollStatus();
    if (!deployRes.response.success) {
      this.ux.stopSpinner('Deployment failed.');
      console.log(JSON.stringify(deployRes.response))

      throw new SfdxError('Deployment failed');
    } else {
      this.ux.stopSpinner('Deployment done.');
    }

    if (type === this.TYPE.CUSTOM_SETTING) {
      const isCsExists = await this.checkCustomSettingsInstanceExists();
      if (!isCsExists) {
        this.createCustomSettingsInstance(name)
      }
    }
  }

  private async saveFile({ directory, fileName, fileContent }): Promise<void> {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(fileName, fileContent);
  }

  private getPackagesAbsolutePath(packageName: string): string {
    return `${this.packageDirs.find(dir => dir.package === packageName).fullPath}${this.sourceSubdir}\\`;
  }

  private async getCustomSettingsObjectName(): Promise<void> {
    let index = 0;
    const conn = this.org.getConnection();
    let objectName: string;

    do {
      index++;
      const name = `Feature${index}__c`;
      try {
        const object = await conn.describe(name);
        const customFieldsCount = (object.fields.filter(field => /__c$/.test(field.name))).length;
        if (customFieldsCount < 5) {
          objectName = name;
        }

      } catch (error) {
        objectName = await this.createNewCustomSettingsObject(name);
      }

    } while (!objectName);
    this.customSettingsObject = objectName;
  }

  private async createNewCustomSettingsObject(name: string) {
    const conn = this.org.getConnection();
    const objectMetadata = {
      fullName: name,
      label: name.replace('__c', ''),
      customSettingsType: 'Hierarchy',
    }
    try {

      await conn.metadata.create('CustomObject', objectMetadata);
    } catch (e) {
      console.error(e);
    }

    return name
  }

  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////
  ///////////////////////////////////////////////////////////////////////////////////////////////////////////

  public async run(): Promise<AnyJson> {
    console.clear();
    EONLogger.log(COLOR_HEADER(LOGOBANNER));

    this.projectJson = await this.project.retrieveSfdxProjectJson();
    this.packageDirs = this.projectJson.getUniquePackageDirectories();
    const packageNames = this.packageDirs.map(dir => dir.package).sort();
    const settings: PluginSettings = this.projectJson.getContents()?.plugins['eon-sfdx'] as PluginSettings;
    const defaultPackage = settings.featureFlagDefaultPackage;
    this.sourceSubdir = settings.sourceSubdir;
    const absolutePath: string = path.dirname(this.projectJson.getPath());

    this.ux.startSpinner('Fetching existing Feature Flags');
    const ffComponents = await getFeatureFlagComponents(absolutePath);
    this.ux.stopSpinner('Success!');
    
    this.categoriesTree = readCategoriesFromFFs(ffComponents);
    this.featureFlagLabels = readLabelsFromFFs(ffComponents);
    console.log("🚀 ~ run ~ this.featureFlagLabels:", this.featureFlagLabels)
    this.categoriesItemsSet = getCategoriesItemsSet(this.categoriesTree);

    const label = await new Input({
      name: 'Label',
      message: 'Enter Feature Flag Label',
      validate: (value: string) => {
        if (this.featureFlagLabels.includes(value)) {
          return chalk.red('Feature Flag Label must be unique.')
        }
        return true;
      }
    }).run();

    const defaultName = this.convertLabelToApiName(label);

    const name = await new Input({
      name: 'Name',
      message: 'Enter Feature Flag Name (enter to confirm default)',
      initial: defaultName,
      validate: (value: string) => {
        if (this.REGEX.APINAME_VALIDATE.test(value)) {
          return chalk.red(`The custom field name you provided ${value} can only contain alphanumeric characters, must begin with a letter, cannot end with an underscore or contain two consecutive underscore characters.`)
        }
        return true;
      }
    }).run();

    const category = await this.getCategoryFromUser();

    const packageName = await new AutoComplete({
      name: 'package',
      message: 'Select your package',
      limit: 15,
      initial: 2,
      choices: packageNames,
      footer() {
        return chalk.dim('(Scroll up and down to reveal more choices)');
      }
    }).run();

    const packageDir = this.getPackagesAbsolutePath(packageName);
    const defaultDir = this.getPackagesAbsolutePath(defaultPackage);

    const sourcesToDeploy = [];

    const type = await new Select({
      name: 'type',
      message: 'Select Feature Flag type',
      choices: Object.values(this.TYPE)
    }).run();

    if (type === this.TYPE.CUSTOM_PERMISSION) {
      const permissionSetData = await this.handlePermissionSet({ name, packageName });
      if (permissionSetData) {
        const {
          content: psContent,
          filePath: psFilePath,
          dirPath: psDirPath
        } = permissionSetData;
        await this.saveFile({ directory: psDirPath, fileName: psFilePath, fileContent: psContent });
        sourcesToDeploy.push(psFilePath);
      }
      const {
        content: cpContent,
        filePath: cpFilePath,
        dirPath: cpDirPath
      } = this.generateCustomPermission({ label, name, packageDir });
      await this.saveFile({ directory: cpDirPath, fileName: cpFilePath, fileContent: cpContent });
      sourcesToDeploy.push(cpFilePath);


    } else if (type === this.TYPE.CUSTOM_SETTING) {
      await this.getCustomSettingsObjectName();

      const {
        content: csContent,
        filePath: csFilePath,
        dirPath: csDirPath
      } = this.generateCustomSettingField({ object: this.customSettingsObject, name, label, packageDir })
      await this.saveFile({ directory: csDirPath, fileName: csFilePath, fileContent: csContent })
      sourcesToDeploy.push(csFilePath);

      const {
        content: objContent,
        filePath: objFilePath,
        dirPath: objDirPath
      } = this.generateCustomSettingsObject({ object: this.customSettingsObject, defaultDir });
      try {
        await fs.access(objFilePath);
      } catch (_) {
        await this.saveFile({ directory: objDirPath, fileName: objFilePath, fileContent: objContent })
        sourcesToDeploy.push(objFilePath);
      };
    }

    const {
      content: mdContent,
      filePath: mdFilePath,
      dirPath: mdDirPath
    } = this.generateCustomMetadataRecord({ label, object: this.customSettingsObject, category, type, name, packageDir });
    await this.saveFile({ directory: mdDirPath, fileName: mdFilePath, fileContent: mdContent })
    sourcesToDeploy.push(mdFilePath);

    const shouldDeploy = await new Toggle({
      name: 'shouldDeploy',
      message: 'Deploy Metadata after creating?',
      enabled: 'Yes',
      disabled: 'No',
      initial: 'Yes'
    }).run()

    if (shouldDeploy) {
      this.deployFeatureFlag({ name, object: this.customSettingsObject, sourcesToDeploy, type });
    } else {
      EONLogger.log('To deploy freshly created Feature Flag use following command:');
      EONLogger.log(chalk.inverse(`sfdx force:source:deploy -p "${sourcesToDeploy.join(',')}"`))
    }

    return toAnyJson({});
  }
}
