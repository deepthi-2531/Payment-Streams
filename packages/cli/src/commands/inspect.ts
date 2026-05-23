/**
 * @module commands/inspect
 *
 * `canton-streams inspect` — Inspect a stream by sender + streamId.
 * Shows config, state, and display-only balance estimates.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import chalk from 'chalk';
import ora from 'ora';
import { CantonStreamsClient, getBalances } from '@canton-streams/sdk';
import { resolveConfig, type GlobalOptions } from '../config.js';
import { printStreamDetail, printJson } from '../output.js';

interface InspectArgs extends GlobalOptions {
  sender: string;
  'stream-id': string;
  json?: boolean;
}

export const command = 'inspect';
export const describe = 'Inspect a stream (config, state, and balances)';

export function builder(yargs: Argv): Argv<InspectArgs> {
  return yargs
    .option('sender', {
      type: 'string',
      demandOption: true,
      describe: 'Sender party of the stream',
    })
    .option('stream-id', {
      type: 'string',
      demandOption: true,
      describe: 'Unique stream identifier',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Output as JSON',
    }) as unknown as Argv<InspectArgs>;
}

export async function handler(argv: ArgumentsCamelCase<InspectArgs>): Promise<void> {
  const config = resolveConfig(argv);

  if (config.actAs.length === 0) {
    console.error(chalk.red('Error: --party is required (or set CANTON_PARTY / config file)'));
    process.exit(1);
  }

  const spinner = ora('Fetching stream details...').start();
  const client = new CantonStreamsClient(config);

  try {
    const stream = await client.getStream(argv.sender, argv.streamId);
    const balances = getBalances(stream);
    spinner.stop();

    if (argv.json) {
      printJson({ stream, balances });
    } else {
      printStreamDetail(stream, balances);
    }
  } catch (err) {
    spinner.fail(chalk.red('Failed to inspect stream'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    await client.close();
  }
}
