/**
 * @module commands/withdraw
 *
 * `canton-streams withdraw` — Withdraw accrued tokens from a stream.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import chalk from 'chalk';
import ora from 'ora';
import { CantonStreamsClient } from '@canton-streams/sdk';
import { resolveConfig, type GlobalOptions } from '../config.js';
import { fmtDecimal } from '../output.js';

interface WithdrawArgs extends GlobalOptions {
  sender: string;
  'stream-id': string;
}

export const command = 'withdraw';
export const describe = 'Withdraw accrued tokens from a stream';

export function builder(yargs: Argv): Argv<WithdrawArgs> {
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
    }) as unknown as Argv<WithdrawArgs>;
}

export async function handler(argv: ArgumentsCamelCase<WithdrawArgs>): Promise<void> {
  const config = resolveConfig(argv);

  if (config.actAs.length === 0) {
    console.error(chalk.red('Error: --party is required (or set CANTON_PARTY / config file)'));
    process.exit(1);
  }

  const spinner = ora('Withdrawing from stream...').start();
  const client = new CantonStreamsClient(config);

  try {
    const result = await client.withdraw(argv.sender, argv.streamId);
    spinner.succeed(chalk.green('Withdrawal successful'));
    console.log();
    console.log(`  ${chalk.bold('Amount Withdrawn:')}  ${fmtDecimal(result.amountWithdrawn)}`);
    console.log(`  ${chalk.bold('Total Withdrawn:')}   ${fmtDecimal(result.newTotalWithdrawn)}`);
    console.log(`  ${chalk.bold('New Status:')}        ${result.newStatus}`);
  } catch (err) {
    spinner.fail(chalk.red('Withdrawal failed'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    await client.close();
  }
}
