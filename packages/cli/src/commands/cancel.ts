/**
 * @module commands/cancel
 *
 * `canton-streams cancel` — Cancel a stream (sender-only or mutual).
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import chalk from 'chalk';
import ora from 'ora';
import { CantonStreamsClient } from '@canton-streams/sdk';
import { resolveConfig, type GlobalOptions } from '../config.js';
import { fmtDecimal } from '../output.js';

interface CancelArgs extends GlobalOptions {
  sender: string;
  'stream-id': string;
  mutual: boolean;
}

export const command = 'cancel';
export const describe = 'Cancel a payment stream';

export function builder(yargs: Argv): Argv<CancelArgs> {
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
    .option('mutual', {
      type: 'boolean',
      default: false,
      describe: 'Use mutual cancellation (requires both parties as actAs)',
    }) as unknown as Argv<CancelArgs>;
}

export async function handler(argv: ArgumentsCamelCase<CancelArgs>): Promise<void> {
  const config = resolveConfig(argv);

  if (config.actAs.length === 0) {
    console.error(chalk.red('Error: --party is required (or set CANTON_PARTY / config file)'));
    process.exit(1);
  }

  const label = argv.mutual ? 'Mutual cancellation' : 'Cancellation';
  const spinner = ora(`${label} in progress...`).start();
  const client = new CantonStreamsClient(config);

  try {
    const result = argv.mutual
      ? await client.mutualCancel(argv.sender, argv.streamId)
      : await client.cancel(argv.sender, argv.streamId);

    spinner.succeed(chalk.green(`${label} successful`));
    console.log();
    console.log(`  ${chalk.bold('Refunded (sender):')} ${fmtDecimal(result.senderRefund)}`);
    console.log(`  ${chalk.bold('Released (recip):')}  ${fmtDecimal(result.recipientAmount)}`);
  } catch (err) {
    spinner.fail(chalk.red(`${label} failed`));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    await client.close();
  }
}
