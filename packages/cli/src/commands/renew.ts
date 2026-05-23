/**
 * @module commands/renew
 *
 * `canton-streams renew` — Renew a renewable-term stream.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import Decimal from 'decimal.js';
import chalk from 'chalk';
import ora from 'ora';
import { CantonStreamsClient } from '@canton-streams/sdk';
import type { LedgerRecord, RenewParams } from '@canton-streams/sdk';
import { resolveConfig, type GlobalOptions } from '../config.js';

interface RenewArgs extends GlobalOptions {
  sender: string;
  'stream-id': string;
  amount: string;
  'new-end-time': string;
  'holding-cid': string;
  'sender-account': string;
}

export const command = 'renew';
export const describe = 'Renew a renewable-term stream';

export function builder(yargs: Argv): Argv<RenewArgs> {
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
    .option('amount', {
      type: 'string',
      demandOption: true,
      describe: 'Additional deposit amount for the new term',
    })
    .option('new-end-time', {
      type: 'string',
      demandOption: true,
      describe: 'New end time for the renewed term (ISO 8601)',
    })
    .option('holding-cid', {
      type: 'string',
      demandOption: true,
      describe: 'Holding contract ID for the renewal top-up',
    })
    .option('sender-account', {
      type: 'string',
      demandOption: true,
      describe: 'Sender account key as JSON',
    }) as unknown as Argv<RenewArgs>;
}

export async function handler(argv: ArgumentsCamelCase<RenewArgs>): Promise<void> {
  const config = resolveConfig(argv);

  if (config.actAs.length === 0) {
    console.error(chalk.red('Error: --party is required (or set CANTON_PARTY / config file)'));
    process.exit(1);
  }

  const spinner = ora('Renewing stream...').start();
  const client = new CantonStreamsClient(config);

  try {
    const params: RenewParams = {
      additionalAmount: new Decimal(argv.amount),
      newEndTime: new Date(argv.newEndTime),
      holdingCid: argv.holdingCid,
      senderAccount: parseLedgerRecord(argv.senderAccount),
    };

    const newContractId = await client.renew(argv.sender, argv.streamId, params);
    spinner.succeed(chalk.green('Stream renewed successfully'));
    console.log();
    console.log(`  ${chalk.bold('Stream ID:')}        ${argv.streamId}`);
    console.log(`  ${chalk.bold('New Contract ID:')}  ${newContractId}`);
    console.log(`  ${chalk.bold('Additional Amt:')}   ${argv.amount}`);
    console.log(`  ${chalk.bold('New End Time:')}     ${argv.newEndTime}`);
  } catch (err) {
    spinner.fail(chalk.red('Renewal failed'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    await client.close();
  }
}

function parseLedgerRecord(value: string): LedgerRecord {
  try {
    const parsed = JSON.parse(value) as LedgerRecord;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
      throw new Error('must be a non-empty JSON object');
    }
    return parsed;
  } catch (err) {
    console.error(
      chalk.red(
        `Error: --sender-account must be a valid JSON object (${err instanceof Error ? err.message : String(err)})`,
      ),
    );
    process.exit(1);
  }
}
