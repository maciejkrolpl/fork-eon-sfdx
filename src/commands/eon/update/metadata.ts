/* eslint-disable @typescript-eslint/quotes */
/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as os from 'os';
import { flags, SfdxCommand } from '@salesforce/command';
import { Messages, SfdxError, SfdxProjectJson } from '@salesforce/core';
import EONLogger, { COLOR_HEADER, COLOR_NOTIFY, COLOR_SUCCESS, COLOR_WARNING } from '../../../eon/EONLogger';
import { LOGOBANNER } from '../../../eon/logo';
import getSettingValue from '../../../helper/aliasify-configuration';
import { getAllFiles } from '../../../helper/package-permissionsets';
import fspromise from 'fs/promises';
import { PluginSettings } from '../../../helper/types';
import path from 'path';

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages('@eon-com/eon-sfdx', 'update');

export default class Metadata extends SfdxCommand {
  public static description = messages.getMessage('commandDescription_metadata');

  public static examples = messages.getMessage('examples_metadata').split(os.EOL);

  public static args = [{ name: 'file' }];

  protected static flagsConfig = {
    // Label For Named Credential as Required
    directory: flags.string({
      char: 'd',
      description: messages.getMessage('directoryMetadataFlagDescription'),
      required: true,
    }),
    artifactdirectory: flags.string({
      char: 'k',
      description: messages.getMessage('artifactDirectoryMetadataFlagDescription'),
    }),
    placeholder: flags.string({
      char: 'p',
      description: messages.getMessage('placeholderMetadataFlagDescription'),
      required: true,
    }),
    value: flags.string({
      char: 'v',
      description: messages.getMessage('valueMetadataFlagDescription'),
      required: true,
    }),
    alias: flags.string({
      char: 'a',
      description: messages.getMessage('aliasDescription'),
    }),
  };

  protected static requiresUsername = false;
  protected static requiresProject = true;

  public async run(): Promise<void> {
    EONLogger.log(COLOR_HEADER(LOGOBANNER));

    // get sfdx project.json
    const projectJson: SfdxProjectJson = await this.project.retrieveSfdxProjectJson();
    const settings: PluginSettings = projectJson.getContents()?.plugins['eon-sfdx'] as PluginSettings;

    // prepare values and settings
    const value = await getSettingValue(this.flags.value, this.flags.alias, this.project);
    const placeholder = settings.metadataPlaceholderFormat
      ? settings.metadataPlaceholderFormat.replace('placeholder', this.flags.placeholder)
      : `{[${this.flags.placeholder}]}`;

    const targetdir = path.normalize(path.join(process.cwd(),this.flags.directory))
    try {
      const dirStat = await fspromise.stat(targetdir);
      let updatedFiles: string[] = [];
      if (dirStat.isDirectory()) {
        const filePaths = getAllFiles(targetdir);
        for await (const p of filePaths) {
          const raw = await fspromise.readFile(p);
          let content = raw.toString();
          if (content.includes(placeholder)) {
            content = content.replace(placeholder, value);
            await fspromise.writeFile(p, content);
            updatedFiles = [...updatedFiles, path.basename(p)];
          }
        }
      } else {
        const raw = await fspromise.readFile(targetdir);
        let content = raw.toString();
        if (content.includes(placeholder)) {
          content = content.replace(placeholder, value);
          await fspromise.writeFile(targetdir, content);
          updatedFiles = [...updatedFiles, path.basename(targetdir)];
        }
      }

      if (updatedFiles.length > 0) {
        EONLogger.log(
          COLOR_SUCCESS(
            `
The placeholder ` +
              COLOR_NOTIFY(placeholder) +
              ` was updated for following files:`
          )
        );
        const Table = require('cli-table3');
        let print = new Table({
          head: [COLOR_NOTIFY('Updated files')],
        });
        updatedFiles.forEach((f) => print.push([f]));
        console.log(print.toString());
      } else {
        EONLogger.log(
          COLOR_WARNING(`
The placeholder was not found in specified file(s): No changes done.`)
        );
      }
    } catch (e) {
      throw new SfdxError(
        'No files found for this path or directory. Please ensure that --directory points to a valid folder or file.'
      );
    }
  }
}
