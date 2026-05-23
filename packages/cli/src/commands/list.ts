/**
 * @module commands/list
 *
 * `canton-streams list` — List streams with optional filters.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import chalk from 'chalk';
import ora from 'ora';
import { CantonStreamsClient } from '@canton-streams/sdk';
import type { StreamFilter , StreamStatus } from '@canton-streams/sdk';
import { resolveConfig, type GlobalOptions } from '../config.js';
import { printStreamTable, printJson } from '../output.js';

interface ListArgs extends GlobalOptions {
  sender?: string;
  recipient?: string;
  status?: string;
  json?: boolean;
}

export const command = 'list';
export const describe = 'List payment streams';

export function builder(yargs: Argv): Argv<ListArgs> {
  return yargs
    .option('sender', {
      type: 'string',
      describe: 'Filter by sender party',
    })
    .option('recipient', {
      type: 'string',
      describe: 'Filter by recipient party',
    })
    .option('status', {
      type: 'string',
      choices: ['Active', 'Completed', 'Cancelled'],
      describe: 'Filter by stream status',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Output as JSON',
    }) as unknown as Argv<ListArgs>;
}

export async function handler(argv: ArgumentsCamelCase<ListArgs>): Promise<void> {
  const config = resolveConfig(argv);

  if (config.actAs.length === 0) {
    console.error(chalk.red('Error: --party is required (or set CANTON_PARTY / config file)'));
    process.exit(1);
  }

  const filter: StreamFilter = {};
  if (argv.sender) (filter as any).sender = argv.sender;
  if (argv.recipient) (filter as any).recipient = argv.recipient;
  if (argv.status) (filter as any).status = argv.status as StreamStatus;

  const spinner = ora('Fetching streams...').start();
  const client = new CantonStreamsClient(config);

  try {
    const streams = await client.listStreams(filter);
    spinner.stop();

    if (argv.json) {
      printJson(streams);
    } else {
      console.log(chalk.bold(`Found ${streams.length} stream(s)\n`));
      printStreamTable(streams);
    }
  } catch (err) {
    spinner.fail(chalk.red('Failed to list streams'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    await client.close();
  }
}
