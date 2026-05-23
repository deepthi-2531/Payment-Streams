#!/usr/bin/env node

import { createRequire } from 'node:module';
import {
  AssetType,
  CantonStreamsClient,
  SettlementMode,
  VestingMode,
  getBalances,
} from '../packages/sdk/dist/index.js';

const requireFromSdk = createRequire(new URL('../packages/sdk/package.json', import.meta.url));
const Decimal = requireFromSdk('decimal.js');

function usage() {
  console.error(
    'usage: node scripts/devnet-smoke.mjs <create|accept|finalize|inspect|list|withdraw|cancel>',
  );
  process.exit(1);
}

function fail(message) {
  throw new Error(message);
}

function env(name, required = true) {
  const value = process.env[name]?.trim();
  if (required && !value) {
    fail(`missing env var: ${name}`);
  }
  return value;
}

function parseCsv(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseJsonEnv(name, required = false) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    if (required) fail(`missing env var: ${name}`);
    return undefined;
  }
  return JSON.parse(raw);
}

function parseSettlementMode(value) {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'utility':
    case 'utilityholdingcustody':
    case 'utility-holding-custody':
      return SettlementMode.UtilityHoldingCustody;
    case 'localassetcustody':
    case 'local-asset-custody':
    case 'local-asset':
      return SettlementMode.LocalAssetCustody;
    case 'tokenstandardcustody':
    case 'token-standard-custody':
    case 'token-standard':
      return SettlementMode.TokenStandardCustody;
    case 'numericlegacy':
    case 'numeric':
      return SettlementMode.NumericLegacy;
    default:
      fail(`unsupported SETTLEMENT_MODE: ${value}`);
  }
}

function parseAssetType(value) {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'validatorlocalasset':
    case 'validator-local-asset':
    case 'local-asset':
      return AssetType.ValidatorLocalAsset;
    case 'localcip56':
    case 'local-cip56':
      return AssetType.LocalCip56;
    case 'globalcip56':
    case 'global-cip56':
      return AssetType.GlobalCip56;
    default:
      fail(`unsupported ASSET_TYPE: ${value}`);
  }
}

function buildVestingMode() {
  const rawMode = (env('VESTING_MODE') ?? 'linear').trim().toLowerCase();
  switch (rawMode) {
    case 'linear':
      return { mode: VestingMode.Linear };
    case 'cliff':
      return {
        mode: VestingMode.CliffLinear,
        cliffTime: new Date(env('CLIFF_TIME')),
      };
    case 'stepped':
      return {
        mode: VestingMode.Stepped,
        stepInterval: Number(env('STEP_INTERVAL')),
        amountPerStep: new Decimal(env('AMOUNT_PER_STEP')),
      };
    case 'renewable':
      return {
        mode: VestingMode.RenewableTerm,
        termDuration: Number(env('TERM_DURATION')),
      };
    default:
      fail(`unsupported VESTING_MODE: ${rawMode}`);
  }
}

function toOutputJson(value) {
  return JSON.stringify(
    value,
    (_key, current) => {
      if (current instanceof Date) return current.toISOString();
      if (current && typeof current === 'object' && typeof current.toString === 'function') {
        if (current.constructor?.name === 'Decimal') return current.toString();
      }
      return current;
    },
    2,
  );
}

function createClient() {
  const actAs = parseCsv(env('CANTON_SMOKE_ACT_AS'));
  if (actAs.length === 0) {
    fail('CANTON_SMOKE_ACT_AS must include at least one party');
  }

  const readAs = parseCsv(process.env['CANTON_SMOKE_READ_AS']);

  return new CantonStreamsClient({
    host: env('CANTON_SMOKE_HOST'),
    port: Number(env('CANTON_SMOKE_PORT')),
    useTls: parseBoolean('CANTON_SMOKE_TLS'),
    token: process.env['CANTON_SMOKE_TOKEN'] || undefined,
    userId: process.env['CANTON_SMOKE_USER_ID'] || undefined,
    synchronizerId: process.env['CANTON_SMOKE_SYNCHRONIZER_ID'] || undefined,
    actAs,
    readAs: readAs.length > 0 ? readAs : undefined,
  });
}

async function runCreate() {
  const settlementMode = parseSettlementMode(env('SETTLEMENT_MODE'));
  const assetType = parseAssetType(
    process.env['ASSET_TYPE'] ??
      (settlementMode === SettlementMode.LocalAssetCustody ? 'validator-local-asset' : 'global-cip56'),
  );

  const instrumentRef =
    assetType === AssetType.ValidatorLocalAsset
      ? undefined
      : {
          depository: env('INSTRUMENT_DEPOSITORY'),
          issuer: env('INSTRUMENT_ISSUER'),
          instrumentId: env('INSTRUMENT_ID'),
          instrumentVersion: env('INSTRUMENT_VERSION'),
        };

  const params = {
    streamId: process.env['STREAM_ID']?.trim() || undefined,
    sender: env('SENDER_PARTY'),
    recipient: env('RECIPIENT_PARTY'),
    totalDeposited: new Decimal(env('STREAM_AMOUNT')),
    startTime: new Date(env('START_TIME')),
    endTime: new Date(env('END_TIME')),
    vestingMode: buildVestingMode(),
    assetType,
    settlementMode,
    holdingCid: env('HOLDING_CID'),
    ...(instrumentRef ? { instrumentRef } : {}),
    ...(parseJsonEnv('SENDER_ACCOUNT_JSON') ? { senderAccount: parseJsonEnv('SENDER_ACCOUNT_JSON') } : {}),
    ...(parseJsonEnv('RECIPIENT_ACCOUNT_JSON') ? { recipientAccount: parseJsonEnv('RECIPIENT_ACCOUNT_JSON') } : {}),
    escrowOperator: env('ESCROW_OPERATOR_PARTY'),
    cancellable: parseBoolean('CANCELLABLE', true),
  };

  const client = createClient();
  try {
    const result = await client.createStream(params);
    console.log(`Stream ID: ${result.streamId}`);
    console.log(`Contract ID: ${result.requestContractId}`);
    console.log(`Settlement Mode: ${settlementMode}`);
    console.log(`Asset Type: ${assetType}`);
  } finally {
    await client.close();
  }
}

async function runAccept() {
  const client = createClient();
  try {
    const result = await client.acceptStream(env('SENDER_PARTY'), env('STREAM_ID'));
    console.log(`Accept Result Contract ID: ${result.escrowContractId}`);
  } finally {
    await client.close();
  }
}

async function runFinalize() {
  const client = createClient();
  try {
    const result = await client.finalizeEscrow(
      env('SENDER_PARTY'),
      env('STREAM_ID'),
      env('ACCEPTED_REQUEST_CONTRACT_ID'),
      parseSettlementMode(env('SETTLEMENT_MODE')),
    );
    console.log(`Active Stream Contract ID: ${result.escrowContractId}`);
  } finally {
    await client.close();
  }
}

async function runInspect() {
  const client = createClient();
  try {
    const stream = await client.getStream(env('SENDER_PARTY'), env('STREAM_ID'));
    const balances = getBalances(stream);
    console.log(toOutputJson({ stream, balances }));
  } finally {
    await client.close();
  }
}

async function runList() {
  const client = createClient();
  try {
    const streams = await client.listStreams({ sender: env('SENDER_PARTY') });
    console.log(toOutputJson(streams));
  } finally {
    await client.close();
  }
}

async function runWithdraw() {
  const client = createClient();
  try {
    const result = await client.withdraw(env('SENDER_PARTY'), env('STREAM_ID'));
    console.log(`Amount Withdrawn: ${result.amountWithdrawn.toString()}`);
    console.log(`Total Withdrawn: ${result.newTotalWithdrawn.toString()}`);
    console.log(`New Status: ${result.newStatus}`);
  } finally {
    await client.close();
  }
}

async function runCancel() {
  const client = createClient();
  try {
    const result = await client.cancel(env('SENDER_PARTY'), env('STREAM_ID'));
    console.log(`Recipient Amount: ${result.recipientAmount.toString()}`);
    console.log(`Sender Refund: ${result.senderRefund.toString()}`);
  } finally {
    await client.close();
  }
}

const action = process.argv[2];
if (!action) usage();

const actions = {
  create: runCreate,
  accept: runAccept,
  finalize: runFinalize,
  inspect: runInspect,
  list: runList,
  withdraw: runWithdraw,
  cancel: runCancel,
};

if (!(action in actions)) usage();

actions[action]()
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
