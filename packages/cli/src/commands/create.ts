/**
 * @module commands/create
 *
 * `canton-streams create` — Create a single V2 token-standard payment stream.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import Decimal from 'decimal.js';
import chalk from 'chalk';
import ora from 'ora';
import { AssetType, CantonStreamsClient, SettlementMode, VestingMode } from '@canton-streams/sdk';
import type {
  CreateStreamParams,
  InstrumentRef,
  LedgerRecord,
  VestingModeConfig,
} from '@canton-streams/sdk';
import { resolveConfig, type GlobalOptions } from '../config.js';

interface CreateArgs extends GlobalOptions {
  sender: string;
  recipient: string;
  amount: string;
  'start-time': string;
  'end-time': string;
  vesting: string;
  'cliff-time'?: string;
  'step-interval'?: number;
  'amount-per-step'?: string;
  'term-duration'?: number;
  'asset-type': string;
  'funding-reference': string;
  'sender-account': string;
  'recipient-account': string;
  'escrow-operator': string;
  'instrument-admin': string;
  'instrument-id': string;
  cancellable: boolean;
}

export const command = 'create';
export const describe = 'Create a single V2 token-standard payment stream';

export function builder(yargs: Argv): Argv<CreateArgs> {
  return yargs
    .option('sender', {
      type: 'string',
      demandOption: true,
      describe: 'Canton party funding the stream',
    })
    .option('recipient', {
      type: 'string',
      demandOption: true,
      describe: 'Canton party receiving streamed funds',
    })
    .option('amount', {
      type: 'string',
      demandOption: true,
      describe: 'Total amount to deposit (decimal string)',
    })
    .option('start-time', {
      type: 'string',
      demandOption: true,
      describe: 'Vesting start time (ISO 8601)',
    })
    .option('end-time', {
      type: 'string',
      demandOption: true,
      describe: 'Vesting end time (ISO 8601)',
    })
    .option('vesting', {
      type: 'string',
      choices: ['linear', 'cliff', 'stepped', 'renewable'],
      default: 'linear',
      describe: 'Vesting mode',
    })
    .option('cliff-time', {
      type: 'string',
      describe: 'Cliff release time (ISO 8601, required for cliff vesting)',
    })
    .option('step-interval', {
      type: 'number',
      describe: 'Interval between steps in microseconds (required for stepped vesting)',
    })
    .option('amount-per-step', {
      type: 'string',
      describe: 'Fixed amount unlocked per step (required for stepped vesting)',
    })
    .option('term-duration', {
      type: 'number',
      describe: 'Duration of each term in microseconds (required for renewable vesting)',
    })
    .option('asset-type', {
      type: 'string',
      choices: ['local-cip56', 'global-cip56'],
      default: 'global-cip56',
      describe: 'CIP-56 V2 asset scope',
    })
    .option('funding-reference', {
      type: 'string',
      demandOption: true,
      describe: 'V2 funding/allocation reference prepared by the Amulet wallet',
    })
    .option('sender-account', {
      type: 'string',
      demandOption: true,
      describe: 'Sender Amulet account key as JSON',
    })
    .option('recipient-account', {
      type: 'string',
      demandOption: true,
      describe: 'Recipient account key as JSON',
    })
    .option('escrow-operator', {
      type: 'string',
      demandOption: true,
      describe: 'Escrow operator party for V2 stream settlement',
    })
    .option('instrument-admin', {
      type: 'string',
      demandOption: true,
      describe: 'CIP-56 V2 instrument admin party',
    })
    .option('instrument-id', {
      type: 'string',
      demandOption: true,
      describe: 'CIP-56 V2 instrument id (for example CC)',
    })
    .option('cancellable', {
      type: 'boolean',
      default: true,
      describe: 'Whether the sender may cancel the stream',
    }) as unknown as Argv<CreateArgs>;
}

export async function handler(argv: ArgumentsCamelCase<CreateArgs>): Promise<void> {
  const config = resolveConfig(argv);

  if (config.actAs.length === 0) {
    console.error(chalk.red('Error: --party is required (or set CANTON_PARTY / config file)'));
    process.exit(1);
  }

  const vestingMode = buildVestingMode(argv);
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const senderAccount = parseLedgerRecord(argv.senderAccount, 'sender-account');
  const recipientAccount = parseLedgerRecord(argv.recipientAccount, 'recipient-account');
  const instrumentRef: InstrumentRef = {
    depository: argv.instrumentAdmin,
    issuer: argv.instrumentAdmin,
    instrumentId: argv.instrumentId,
    instrumentVersion: 'v2',
  };

  const params: CreateStreamParams = {
    streamId,
    sender: argv.sender,
    recipient: argv.recipient,
    totalDeposited: new Decimal(argv.amount),
    startTime: new Date(argv.startTime),
    endTime: new Date(argv.endTime),
    vestingMode,
    assetType: parseAssetType(argv.assetType),
    instrumentRef,
    fundingReference: argv.fundingReference,
    senderAccount,
    recipientAccount,
    settlementMode: SettlementMode.TokenStandardCustody,
    escrowOperator: argv.escrowOperator,
    cancellable: argv.cancellable,
  };

  const spinner = ora('Creating V2 token-standard payment stream...').start();
  const client = new CantonStreamsClient(config);

  try {
    const result = await client.createStream(params);
    spinner.succeed(chalk.green('V2 token-standard stream created successfully'));
    console.log();
    console.log(`  ${chalk.bold('Stream ID:')}      ${result.streamId}`);
    console.log(`  ${chalk.bold('Contract ID:')}   ${result.requestContractId}`);
    console.log(`  ${chalk.bold('Sender:')}        ${params.sender}`);
    console.log(`  ${chalk.bold('Recipient:')}     ${params.recipient}`);
    console.log(`  ${chalk.bold('Amount:')}        ${params.totalDeposited.toString()}`);
    console.log(`  ${chalk.bold('Settlement:')}    ${params.settlementMode}`);
    console.log(`  ${chalk.bold('Asset Mode:')}    ${params.assetType}`);
    console.log(`  ${chalk.bold('Instrument ID:')} ${instrumentRef.instrumentId}`);
    console.log(`  ${chalk.bold('Funding Ref:')}   ${params.fundingReference}`);
  } catch (err) {
    spinner.fail(chalk.red('Failed to create stream'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  } finally {
    await client.close();
  }
}

function parseAssetType(value: string): AssetType {
  switch (value) {
    case 'local-cip56':
      return AssetType.LocalCip56;
    case 'global-cip56':
      return AssetType.GlobalCip56;
    default:
      return AssetType.GlobalCip56;
  }
}

function parseLedgerRecord(value: string, flag: string): LedgerRecord {
  try {
    const parsed = JSON.parse(value) as LedgerRecord;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length === 0
    ) {
      throw new Error('must be a non-empty JSON object');
    }
    return parsed;
  } catch (err) {
    console.error(
      chalk.red(
        `Error: --${flag} must be a valid JSON object (${err instanceof Error ? err.message : String(err)})`,
      ),
    );
    process.exit(1);
  }
}

function buildVestingMode(argv: ArgumentsCamelCase<CreateArgs>): VestingModeConfig {
  switch (argv.vesting) {
    case 'linear':
      return { mode: VestingMode.Linear };

    case 'cliff': {
      if (!argv.cliffTime) {
        console.error(chalk.red('Error: --cliff-time is required for cliff vesting'));
        process.exit(1);
      }
      return {
        mode: VestingMode.CliffLinear,
        cliffTime: new Date(argv.cliffTime),
      };
    }

    case 'stepped': {
      if (!argv.stepInterval || !argv.amountPerStep) {
        console.error(
          chalk.red(
            'Error: --step-interval and --amount-per-step are required for stepped vesting',
          ),
        );
        process.exit(1);
      }
      return {
        mode: VestingMode.Stepped,
        stepInterval: argv.stepInterval,
        amountPerStep: new Decimal(argv.amountPerStep),
      };
    }

    case 'renewable': {
      if (!argv.termDuration) {
        console.error(chalk.red('Error: --term-duration is required for renewable vesting'));
        process.exit(1);
      }
      return {
        mode: VestingMode.RenewableTerm,
        termDuration: argv.termDuration,
      };
    }

    default:
      return { mode: VestingMode.Linear };
  }
}
