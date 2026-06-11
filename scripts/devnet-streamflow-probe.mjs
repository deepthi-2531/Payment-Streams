#!/usr/bin/env node
/**
 * StreamFlow probe — one full non-prefunded / rolling top-up cycle
 * against a live network (LocalNet / DevNet / TestNet).
 *
 * Targets the Canton 3.x JSON Ledger API **v2** (`/v2/...`). Run it
 * from a host that can reach the participant. The canton-streams DAR
 * must be uploaded + vetted, and sender / recipient / escrow operator
 * must be hosted on the participant (StreamFlow has all three as
 * signatories, so the probe submits with all three in actAs — a
 * co-hosted probe topology, same caveat as the other probes).
 *
 * Flow (the open-ended happy path):
 *
 *   1. Create `StreamFlow` with a small funded balance.
 *   2. `TopUp_Flow` as sender + operator; assert fundedAmount grew.
 *   3. Wait ACCRUAL_WAIT_SECONDS for accrual, then `Withdraw_Flow` as
 *      recipient + operator; assert totalWithdrawn > 0.
 *   4. `Stop_Flow` as all three with the exact settlement split the
 *      contract recomputes at stopTime (Numeric 10, HALF_EVEN).
 *   5. Assert final ACS state: FlowStopped, totalWithdrawn ==
 *      fundedAmount (nothing left withdrawable, refund recorded).
 *
 * Usage:
 *
 *   CANTON_JSON_API_URL=http://<participant>:7575 \
 *   SENDER_PARTY=... RECIPIENT_PARTY=... ESCROW_OPERATOR_PARTY=... \
 *   INSTRUMENT_ADMIN_PARTY=... INSTRUMENT_ID=Amulet \
 *   node scripts/devnet-streamflow-probe.mjs
 *
 *   Optional: CANTON_LEDGER_TOKEN, CANTON_USER_ID,
 *   CANTON_STREAMS_PACKAGE_REF (default '#canton-streams'),
 *   RATE_PER_SECOND (default 0.01), FLOW_RATE (tokens/µs, overrides),
 *   INITIAL_FUNDING (default 1.0), TOP_UP_AMOUNT (default 5.0),
 *   ACCRUAL_WAIT_SECONDS (default 5), STREAM_ID.
 *
 *   DRY_RUN=true prints the plan without submitting anything.
 */

import { createRequire } from 'node:module';

const requireFromSdk = createRequire(new URL('../packages/sdk/package.json', import.meta.url));
const Decimal = requireFromSdk('decimal.js');
Decimal.set({ precision: 50 });

const env = (name, fallback = '') => String(process.env[name] ?? fallback).trim();

const config = {
  apiUrl: env('CANTON_JSON_API_URL', 'http://localhost:7575').replace(/\/+$/, ''),
  ledgerToken: env('CANTON_LEDGER_TOKEN'),
  userId: env('CANTON_USER_ID', ''),
  packageRef: env('CANTON_STREAMS_PACKAGE_REF', '#canton-streams'),
  senderParty: env('SENDER_PARTY'),
  recipientParty: env('RECIPIENT_PARTY'),
  escrowOperatorParty: env('ESCROW_OPERATOR_PARTY'),
  instrumentAdminParty: env('INSTRUMENT_ADMIN_PARTY', env('ESCROW_OPERATOR_PARTY')),
  instrumentId: env('INSTRUMENT_ID', 'Amulet'),
  instrumentVersion: env('INSTRUMENT_VERSION', 'v2'),
  // Tokens per microsecond. Defaults to RATE_PER_SECOND / 1e6, which
  // must stay representable at Numeric 10 scale (>= 0.0000000001/µs).
  flowRate: env('FLOW_RATE'),
  ratePerSecond: env('RATE_PER_SECOND', '0.01'),
  initialFunding: env('INITIAL_FUNDING', '1.0'),
  topUpAmount: env('TOP_UP_AMOUNT', '5.0'),
  accrualWaitSeconds: Number(env('ACCRUAL_WAIT_SECONDS', '5')),
  streamId: env('STREAM_ID', `flow-probe-${Date.now()}`),
  dryRun: env('DRY_RUN', 'false') === 'true',
};

function log(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

function fail(msg) {
  log(`FAIL: ${msg}`);
  process.exit(1);
}

function preFlightChecks() {
  const errs = [];
  if (!config.senderParty) errs.push('SENDER_PARTY required');
  if (!config.recipientParty) errs.push('RECIPIENT_PARTY required');
  if (!config.escrowOperatorParty) errs.push('ESCROW_OPERATOR_PARTY required');
  if (!config.instrumentAdminParty) errs.push('INSTRUMENT_ADMIN_PARTY required');
  if (errs.length) {
    errs.forEach((e) => log(`preflight: ${e}`));
    fail('preflight checks failed');
  }
}

/** Effective flowRate (tokens/µs) at the contract's Numeric 10 scale. */
function effectiveFlowRate() {
  const rate = config.flowRate
    ? new Decimal(config.flowRate)
    : new Decimal(config.ratePerSecond).div(1_000_000);
  const scaled = rate.toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
  if (scaled.lessThanOrEqualTo(0)) {
    fail(`flowRate ${rate} rounds to ${scaled} at Numeric 10 scale; raise RATE_PER_SECOND`);
  }
  return scaled;
}

// ---------------------------------------------------------------------------
// HTTP helpers (JSON Ledger API v2)
// ---------------------------------------------------------------------------

async function ledger(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.ledgerToken) headers.Authorization = `Bearer ${config.ledgerToken}`;
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = text.length > 1200 ? `${text.slice(0, 400)} … ${text.slice(-700)}` : text;
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

async function ledgerEnd() {
  const res = await ledger('GET', '/v2/state/ledger-end');
  return res.offset;
}

async function activeContracts(party, templateId) {
  const offset = await ledgerEnd();
  const res = await ledger('POST', '/v2/state/active-contracts', {
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
  const entries = Array.isArray(res) ? res : (res.activeContracts ?? []);
  return entries
    .map((e) => e.contractEntry?.JsActiveContract ?? e.contractEntry?.activeContract ?? null)
    .filter(Boolean)
    .map((ac) => ({
      contractId: ac.createdEvent?.contractId,
      payload: ac.createdEvent?.createArgument,
    }));
}

let commandCounter = 0;
function commandId(tag) {
  commandCounter += 1;
  return `flow-probe-${tag}-${Date.now()}-${commandCounter}`;
}

async function submitAndWait(tag, actAs, commands) {
  const body = {
    commands,
    commandId: commandId(tag),
    actAs,
    readAs: [],
    ...(config.userId ? { userId: config.userId } : {}),
  };
  const res = await ledger('POST', '/v2/commands/submit-and-wait', body);
  return res; // { updateId, completionOffset }
}

// ---------------------------------------------------------------------------
// Time + accrual math (mirrors CantonStreams.Stream.StreamFlow)
// ---------------------------------------------------------------------------

/** Parse a Daml Time (ISO string or micros-since-epoch) to BigInt micros. */
function parseTimeMicros(raw) {
  const s = String(raw ?? '');
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) fail(`unparseable Daml timestamp: ${s}`);
  const baseMs = Date.parse(`${m[1]}${m[3]}`);
  const fracMicros = m[2] ? BigInt(m[2].padEnd(6, '0').slice(0, 6)) : 0n;
  return BigInt(baseMs) * 1000n + fracMicros;
}

function parseRelTimeMicros(raw) {
  if (raw && typeof raw === 'object' && 'microseconds' in raw) {
    return BigInt(raw.microseconds);
  }
  return BigInt(raw ?? 0);
}

/**
 * Replicate `flowAccrued flowRate elapsedMicros` — Numeric 10
 * multiplication with HALF_EVEN rounding (Daml LF MUL_NUMERIC).
 */
function accruedAt(payload, atMicros) {
  const startMicros = parseTimeMicros(payload.startTime);
  const pausedMicros = parseRelTimeMicros(payload.cumulativePausedDuration);
  const currentPause =
    payload.status === 'FlowPaused' && payload.pausedAt
      ? atMicros - parseTimeMicros(payload.pausedAt)
      : 0n;
  const elapsed = atMicros - startMicros - pausedMicros - currentPause;
  if (elapsed <= 0n) return new Decimal(0);
  return new Decimal(payload.flowRate)
    .times(elapsed.toString())
    .toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
}

/** Replicate `flowWithdrawable accrued fundedAmount totalWithdrawn`. */
function withdrawableAt(payload, atMicros) {
  const accrued = accruedAt(payload, atMicros);
  const funded = new Decimal(payload.fundedAmount);
  const withdrawn = new Decimal(payload.totalWithdrawn);
  return Decimal.max(0, Decimal.min(accrued, funded).minus(withdrawn));
}

/** ISO timestamp at millisecond precision (µs-exact on the ledger). */
function isoNowMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function flowTemplateId() {
  return `${config.packageRef}:CantonStreams.Stream.StreamFlow:StreamFlow`;
}

async function findFlow(required = true) {
  const flows = await activeContracts(config.senderParty, flowTemplateId());
  const mine = flows.find((f) => f.payload?.streamId === config.streamId);
  if (!mine && required) fail(`StreamFlow ${config.streamId} not found in ACS`);
  return mine ?? null;
}

async function createFlow(flowRate, startTimeIso) {
  await submitAndWait(
    'create',
    [config.senderParty, config.recipientParty, config.escrowOperatorParty],
    [
      {
        CreateCommand: {
          templateId: flowTemplateId(),
          createArguments: {
            sender: config.senderParty,
            recipient: config.recipientParty,
            escrowOperator: config.escrowOperatorParty,
            streamId: config.streamId,
            instrumentRef: {
              depository: config.instrumentAdminParty,
              issuer: config.instrumentAdminParty,
              instrumentId: config.instrumentId,
              instrumentVersion: config.instrumentVersion,
            },
            flowRate: flowRate.toFixed(10),
            startTime: startTimeIso,
            fundedAmount: new Decimal(config.initialFunding).toFixed(10),
            totalWithdrawn: '0.0000000000',
            status: 'FlowActive',
            pausedAt: null,
            cumulativePausedDuration: { microseconds: '0' },
            lastSettlementReference: null,
            numIterations: '0',
            observers: [],
          },
        },
      },
    ],
  );
  return findFlow();
}

async function topUpFlow(contractId) {
  await submitAndWait(
    'top-up',
    [config.senderParty, config.escrowOperatorParty],
    [
      {
        ExerciseCommand: {
          templateId: flowTemplateId(),
          contractId,
          choice: 'TopUp_Flow',
          choiceArgument: {
            topUpAmount: new Decimal(config.topUpAmount).toFixed(10),
            settlementReference: `${config.streamId}:top-up-1`,
          },
        },
      },
    ],
  );
  return findFlow();
}

async function withdrawFlow(contractId, withdrawTimeIso) {
  await submitAndWait(
    'withdraw',
    [config.recipientParty, config.escrowOperatorParty],
    [
      {
        ExerciseCommand: {
          templateId: flowTemplateId(),
          contractId,
          choice: 'Withdraw_Flow',
          choiceArgument: {
            withdrawTime: withdrawTimeIso,
            settlementReference: `${config.streamId}:withdraw-1`,
          },
        },
      },
    ],
  );
  return findFlow();
}

async function stopFlow(flow) {
  const stopTimeIso = isoNowMinus(1_000);
  const stopMicros = parseTimeMicros(stopTimeIso);
  // Stop_Flow asserts the split matches its own accrual at stopTime, so
  // compute both legs with the same Numeric 10 arithmetic the contract uses.
  const owed = withdrawableAt(flow.payload, stopMicros);
  const funded = new Decimal(flow.payload.fundedAmount);
  const withdrawn = new Decimal(flow.payload.totalWithdrawn);
  const refund = Decimal.max(0, funded.minus(withdrawn).minus(owed));
  log(`Stop split @ ${stopTimeIso}: recipient=${owed.toFixed(10)}, refund=${refund.toFixed(10)}`);

  await submitAndWait(
    'stop',
    [config.senderParty, config.recipientParty, config.escrowOperatorParty],
    [
      {
        ExerciseCommand: {
          templateId: flowTemplateId(),
          contractId: flow.contractId,
          choice: 'Stop_Flow',
          choiceArgument: {
            stopTime: stopTimeIso,
            recipientSettlement: owed.toFixed(10),
            senderRefund: refund.toFixed(10),
            recipientSettlementReference: owed.greaterThan(0)
              ? `${config.streamId}:final-settle`
              : null,
            senderRefundReference: refund.greaterThan(0) ? `${config.streamId}:refund` : null,
          },
        },
      },
    ],
  );
  return findFlow();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  preFlightChecks();
  const flowRate = effectiveFlowRate();

  log('StreamFlow probe (JSON Ledger API v2) — configuration:');
  log(`  ledger:   ${config.apiUrl}`);
  log(`  template: ${flowTemplateId()}`);
  log(`  flow:     ${config.senderParty} → ${config.recipientParty}`);
  log(`  operator: ${config.escrowOperatorParty}`);
  log(`  rate:     ${flowRate.toFixed(10)} ${config.instrumentId}/µs`);
  log(`  funding:  ${config.initialFunding} initial + ${config.topUpAmount} top-up`);
  log(`  streamId: ${config.streamId}`);

  if (config.dryRun) {
    log('DRY_RUN=true — printing plan only:');
    log('  1. create StreamFlow with the initial funded balance');
    log('  2. TopUp_Flow (sender + operator)');
    log(`  3. wait ${config.accrualWaitSeconds}s, then Withdraw_Flow (recipient + operator)`);
    log('  4. Stop_Flow (all three) with the computed settlement split');
    log('  5. assert final ACS state: FlowStopped, totalWithdrawn == fundedAmount');
    return;
  }

  const version = await ledger('GET', '/v2/version');
  log(`Ledger API: ${version.version}`);

  // STEP 1: create with a small funded balance, accruing from 1s ago.
  let flow = await createFlow(flowRate, isoNowMinus(1_000));
  log(`STEP 1 OK — StreamFlow created: ${flow.contractId}`);

  // STEP 2: top up the funded balance.
  flow = await topUpFlow(flow.contractId);
  const expectedFunded = new Decimal(config.initialFunding).plus(config.topUpAmount);
  if (!new Decimal(flow.payload.fundedAmount).equals(expectedFunded)) {
    fail(`fundedAmount ${flow.payload.fundedAmount} != expected ${expectedFunded}`);
  }
  log(`STEP 2 OK — topped up; fundedAmount=${flow.payload.fundedAmount}`);

  // STEP 3: let accrual build, then withdraw it.
  log(`Waiting ${config.accrualWaitSeconds}s for accrual…`);
  await sleep(config.accrualWaitSeconds * 1000);
  flow = await withdrawFlow(flow.contractId, isoNowMinus(1_000));
  const withdrawn = new Decimal(flow.payload.totalWithdrawn);
  if (withdrawn.lessThanOrEqualTo(0)) {
    fail(`totalWithdrawn ${withdrawn} not positive after Withdraw_Flow`);
  }
  if (Number(flow.payload.numIterations) !== 1) {
    fail(`numIterations ${flow.payload.numIterations} != 1 after first withdrawal`);
  }
  log(`STEP 3 OK — withdrew accrued; totalWithdrawn=${flow.payload.totalWithdrawn}`);

  // STEP 4: mutual stop with the exact split.
  flow = await stopFlow(flow);
  log(`STEP 4 OK — Stop_Flow exercised: ${flow.contractId}`);

  // STEP 5: final-state assertions straight from the ACS.
  const final = flow.payload;
  if (final.status !== 'FlowStopped') {
    fail(`final status ${JSON.stringify(final.status)} != FlowStopped`);
  }
  if (!new Decimal(final.totalWithdrawn).equals(new Decimal(final.fundedAmount))) {
    fail(`final totalWithdrawn ${final.totalWithdrawn} != fundedAmount ${final.fundedAmount}`);
  }
  if (final.pausedAt !== null && final.pausedAt !== undefined) {
    fail(`final pausedAt ${JSON.stringify(final.pausedAt)} should be empty`);
  }
  log(
    `STEP 5 OK — final state: status=FlowStopped, ` +
      `totalWithdrawn=${final.totalWithdrawn}, fundedAmount=${final.fundedAmount}, ` +
      `lastSettlementReference=${JSON.stringify(final.lastSettlementReference)}`,
  );
  log('PROBE PASSED — full StreamFlow cycle settled (create → top-up → withdraw → stop).');
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
