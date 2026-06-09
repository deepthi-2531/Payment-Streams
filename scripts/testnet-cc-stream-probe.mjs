#!/usr/bin/env node
/**
 * Canton Coin (CC) stream lifecycle probe.
 *
 * Exercises the legacy CC stream probe against a Canton ledger:
 *   1. Allocate sender + recipient parties (or reuse from env)
 *   2. Submit `CreateStreamRequest` (NumericLegacy by default; pass
 *      --mode token-standard for the production CC TokenStandardCustody path)
 *   3. Recipient exercises `AcceptStream` — produces a `StreamEscrow`
 *   4. Wait for the configured accrual window
 *   5. Recipient exercises `Withdraw_Stream` — withdraws fully vested amount
 *   6. Print the updateIds + final ledger state for audit
 *
 * ## Flags
 *
 *   --dry-run            Run pre-flight only; submit no commands. Safe for any network.
 *   --target NET         Explicit target: devnet | testnet | mainnet.
 *                        Mainnet additionally requires I_HAVE_MAINNET_CREDENTIALS=true.
 *   --json               Emit machine-readable JSON summary on success.
 *   --mode MODE          Settlement mode: numeric (default sandbox) | token-standard
 *                        (real CC, requires asset-registry entry + funded wallet).
 *
 * ## Environment / local-config overrides (see config/local.testnet.json):
 *
 *   CANTON_JSON_API_URL       JSON Ledger API base URL
 *   CANTON_LEDGER_TOKEN       JWT for authenticated participants
 *   CANTON_STREAMS_PACKAGE_ID package id of canton-streams main DAR
 *   SENDER_PARTY              pre-allocated sender (skips allocation)
 *   RECIPIENT_PARTY           pre-allocated recipient (skips allocation)
 *   DEPOSIT_AMOUNT            defaults to 100.0
 *   STREAM_DURATION_SECONDS   defaults to 60
 *   TARGET_NETWORK            alternative to --target flag
 *
 * See docs/DEPLOYMENT.md for deployment and validation guidance.
 */

import { loadLocalScriptConfig } from './local-config.mjs';
import { runPreflight, printPreflightReport, parseCommonArgs } from './lib/preflight.mjs';

const localConfig = loadLocalScriptConfig('testnetCcStreamProbe').values;
const env = (name, fallback = '') => String(process.env[name] ?? fallback).trim();

// Parse common flags first (extracts --dry-run, --target, --json)
const cliArgs = parseCommonArgs(process.argv);

// Probe-specific flag: --mode numeric|token-standard
let mode = 'numeric';
for (let i = 0; i < cliArgs.raw.length; i++) {
  if (cliArgs.raw[i] === '--mode') {
    const v = (cliArgs.raw[++i] ?? '').toLowerCase();
    if (v !== 'numeric' && v !== 'token-standard') {
      console.error(`Invalid --mode ${v}. Must be "numeric" or "token-standard".`);
      process.exit(2);
    }
    mode = v;
  }
}

const config = {
  apiUrl: (env('CANTON_JSON_API_URL', localConfig.cantonJsonApiUrl ?? 'http://localhost:7575')).replace(/\/+$/, ''),
  ledgerToken: env('CANTON_LEDGER_TOKEN'),
  packageId: env('CANTON_STREAMS_PACKAGE_ID', localConfig.cantonStreamsPackageId ?? ''),
  userId: env('CANTON_USER_ID', 'ledger-api-user'),
  senderParty: env('SENDER_PARTY'),
  recipientParty: env('RECIPIENT_PARTY'),
  depositAmount: env('DEPOSIT_AMOUNT', '100.0'),
  startDelaySeconds: Number(env('STREAM_START_DELAY_SECONDS', '5')),
  durationSeconds: Number(env('STREAM_DURATION_SECONDS', '60')),
  pollIntervalMs: Number(env('POLL_INTERVAL_MS', '2000')),
  streamId: env('STREAM_ID', `cc-stream-${Date.now()}`),
};

function log(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

function httpHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (config.ledgerToken) headers['authorization'] = `Bearer ${config.ledgerToken}`;
  return headers;
}

async function call(method, path, body) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: httpHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

async function allocateParty(hint) {
  log(`Allocating party "${hint}"…`);
  const result = await call('POST', '/v2/parties', { partyIdHint: hint });
  return result.partyDetails.party;
}

async function getLedgerEnd() {
  const { offset } = await call('GET', '/v2/state/ledger-end');
  return Number(offset);
}

async function submitCommand({ commands, actAs }) {
  const commandId = `cmd-cc-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await call('POST', '/v2/commands/submit-and-wait', {
    commands,
    commandId,
    userId: config.userId,
    actAs,
  });
  return { commandId, updateId: result.updateId, completionOffset: result.completionOffset };
}

async function findActiveContractsByTemplate(party, templateId) {
  const offset = await getLedgerEnd();
  const data = await call('POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  });
  const results = [];
  for (const entry of Array.isArray(data) ? data : []) {
    const ce = entry.contractEntry;
    if (!ce || !ce.JsActiveContract) continue;
    const ac = ce.JsActiveContract;
    const created = ac.createdEvent ?? ac;
    results.push({
      contractId: created.contractId,
      args: created.createArgument ?? created.createArguments ?? {},
    });
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('========================================');
  console.log(' Canton Coin (CC) Stream Lifecycle Probe');
  console.log(' TokenStandardCustody verification');
  console.log('========================================\n');
  log(`API URL:           ${config.apiUrl}`);
  log(`Target network:    ${cliArgs.target}`);
  log(`Settlement mode:   ${mode}`);
  log(`Package ID:        ${config.packageId || '(env CANTON_STREAMS_PACKAGE_ID required)'}`);
  log(`Stream ID:         ${config.streamId}`);
  log(`Deposit amount:    ${config.depositAmount} CC`);
  log(`Stream duration:   ${config.durationSeconds}s`);
  log(`Dry-run:           ${cliArgs.dryRun}`);
  log('');

  // ---------------------------------------------------------------------
  // Pre-flight
  // ---------------------------------------------------------------------
  const partiesToCheck = [config.senderParty, config.recipientParty].filter(Boolean);
  const preflight = await runPreflight({
    apiUrl: config.apiUrl,
    ledgerToken: config.ledgerToken,
    packageId: config.packageId,
    parties: partiesToCheck,
    assetKey: mode === 'token-standard' ? 'cc' : undefined,
    targetNetwork: cliArgs.target,
    dryRun: cliArgs.dryRun,
  });
  printPreflightReport(preflight);

  if (!preflight.ok) {
    console.error('Pre-flight failed. Fix the errors above and retry.');
    process.exit(2);
  }
  if (cliArgs.dryRun) {
    console.error('--dry-run requested; exiting before any ledger writes.');
    process.exit(0);
  }

  // ---------------------------------------------------------------------
  // Token-standard mode delegates to the USDCx probe with --asset cc
  // ---------------------------------------------------------------------
  if (mode === 'token-standard') {
    console.error('');
    console.error('⚠ --mode token-standard not implemented in this probe.');
    console.error('');
    console.error('  The production CC TokenStandardCustody flow is exercised by:');
    console.error('    scripts/testnet-usdcx-stream-probe.mjs');
    console.error('  (Despite the name, that probe handles any V1 TokenStandardCustody');
    console.error('  asset; set INSTRUMENT_ID=CC + the CC admin/depository/issuer envs');
    console.error('  to run it for Canton Coin.)');
    console.error('');
    console.error('  This script (testnet-cc-stream-probe.mjs) exercises the simpler');
    console.error('  NumericLegacy sandbox flow used for accrual-math verification.');
    console.error('  Mainnet/TestNet CC runs should use the production probe instead.');
    console.error('');
    console.error('  See docs/DEPLOYMENT.md for setup guidance.');
    process.exit(2);
  }

  if (!config.packageId) {
    throw new Error('CANTON_STREAMS_PACKAGE_ID must be set (run: damlc inspect-dar --json <main.dar> | jq -r ".packages | keys[]" | head -1)');
  }

  // 1. Allocate (or reuse) parties
  const sender = config.senderParty || (await allocateParty('cc-probe-sender'));
  const recipient = config.recipientParty || (await allocateParty('cc-probe-recipient'));
  log(`Sender:            ${sender}`);
  log(`Recipient:         ${recipient}`);
  log('');

  // 2. CreateStreamRequest
  const startTime = new Date(Date.now() + config.startDelaySeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const endTime = new Date(Date.now() + (config.startDelaySeconds + config.durationSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const createTemplateId = `${config.packageId}:CantonStreams.Workflow.CreateStream:CreateStreamRequest`;

  log('Step 1/4: submitting CreateStreamRequest…');
  const createResult = await submitCommand({
    commands: [{
      CreateCommand: {
        templateId: createTemplateId,
        createArguments: {
          config: {
            streamId: config.streamId,
            sender,
            recipient,
            totalDeposited: config.depositAmount,
            startTime,
            endTime,
            vestingMode: { tag: 'Linear', value: {} },
            assetType: 'LocalToken',
            instrumentRef: null,
            cancellable: true,
            settlementMode: 'NumericLegacy',
          },
          depositAmount: config.depositAmount,
          observers: [],
        },
      },
    }],
    actAs: [sender],
  });
  log(`  ✓ updateId:      ${createResult.updateId}`);
  log(`    offset:        ${createResult.completionOffset}`);

  // 3. Find the request CID + Accept
  const requests = await findActiveContractsByTemplate(sender, createTemplateId);
  const request = requests.find((r) => r.args.config?.streamId === config.streamId);
  if (!request) throw new Error('Could not find the CreateStreamRequest we just submitted');
  log(`  CreateStreamRequest CID: ${request.contractId}`);

  log('\nStep 2/4: recipient exercises AcceptStream…');
  const acceptResult = await submitCommand({
    commands: [{
      ExerciseCommand: {
        templateId: createTemplateId,
        contractId: request.contractId,
        choice: 'AcceptStream',
        choiceArgument: {},
      },
    }],
    actAs: [recipient],
  });
  log(`  ✓ updateId:      ${acceptResult.updateId}`);
  log(`    offset:        ${acceptResult.completionOffset}`);

  // 4. Find StreamEscrow + wait for vesting
  const escrowTemplateId = `${config.packageId}:CantonStreams.Stream.Escrow:StreamEscrow`;
  const escrows = await findActiveContractsByTemplate(sender, escrowTemplateId);
  const escrow = escrows.find((e) => e.args.config?.streamId === config.streamId);
  if (!escrow) throw new Error('Could not find the StreamEscrow created by Accept');
  log(`  StreamEscrow CID: ${escrow.contractId}`);
  log(`  Initial state:    status=${escrow.args.state?.status}, withdrawn=${escrow.args.state?.totalWithdrawn}, escrow=${escrow.args.escrow?.amount}`);

  const waitSeconds = config.startDelaySeconds + config.durationSeconds + 5;
  log(`\nStep 3/4: waiting ${waitSeconds}s for full vesting…`);
  await sleep(waitSeconds * 1000);

  // 5. Withdraw
  log('Step 4/4: recipient exercises Withdraw_Stream…');
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const withdrawResult = await submitCommand({
    commands: [{
      ExerciseCommand: {
        templateId: escrowTemplateId,
        contractId: escrow.contractId,
        choice: 'Withdraw_Stream',
        choiceArgument: { withdrawTime: now },
      },
    }],
    actAs: [recipient],
  });
  log(`  ✓ updateId:      ${withdrawResult.updateId}`);
  log(`    offset:        ${withdrawResult.completionOffset}`);

  // 6. Final state
  const finalEscrows = await findActiveContractsByTemplate(sender, escrowTemplateId);
  const finalEscrow = finalEscrows.find((e) => e.args.config?.streamId === config.streamId);
  log('\nFinal state:');
  if (finalEscrow) {
    log(`  status:          ${finalEscrow.args.state?.status}`);
    log(`  totalWithdrawn:  ${finalEscrow.args.state?.totalWithdrawn}`);
    log(`  lastWithdraw:    ${finalEscrow.args.state?.lastWithdrawTime}`);
    log(`  escrow.amount:   ${finalEscrow.args.escrow?.amount}`);
  } else {
    log('  (escrow archived — stream completed and removed from active set)');
  }

  const summary = {
    streamId: config.streamId,
    network: cliArgs.target,
    mode,
    apiUrl: config.apiUrl,
    sender,
    recipient,
    transactions: {
      create: createResult,
      accept: acceptResult,
      withdraw: withdrawResult,
    },
    finalState: finalEscrow ? {
      status: finalEscrow.args.state?.status,
      totalWithdrawn: finalEscrow.args.state?.totalWithdrawn,
      lastWithdrawTime: finalEscrow.args.state?.lastWithdrawTime,
      escrowAmount: finalEscrow.args.escrow?.amount,
    } : { status: 'Archived (completed)' },
  };

  if (cliArgs.json) {
    // Machine-readable JSON on stdout (logs went to stderr).
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    console.log('\n========================================');
    console.log(' ✓ CC stream lifecycle complete');
    console.log('========================================');
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message ?? err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
