/**
 * @module commands/batch
 *
 * `canton-streams batch` — Batch creation is temporarily disabled while the
 * project transitions to holding-backed settlement only.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import chalk from 'chalk';

interface BatchArgs {
  file: string;
}

export const command = 'batch';
export const describe = 'Create multiple streams from a CSV file (temporarily disabled)';

export function builder(yargs: Argv): Argv<BatchArgs> {
  return yargs.option('file', {
    type: 'string',
    demandOption: true,
    describe: 'Path to CSV file with stream definitions',
  }) as unknown as Argv<BatchArgs>;
}

export async function handler(_argv: ArgumentsCamelCase<BatchArgs>): Promise<void> {
  console.error(
    chalk.red(
      'Batch creation is temporarily disabled while the app transitions to holding-backed settlement only.',
    ),
  );
  process.exit(1);
}
