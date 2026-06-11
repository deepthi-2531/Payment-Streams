#!/usr/bin/env node
/**
 * Interest-stream scheduler — "interest mode" reference daemon.
 *
 * Settles fixed-rate interest agreements (e.g. CIP-0105 token-lock
 * interest) on an hourly/daily cadence from the dApp's wallet to each
 * client's wallet, with arrears catch-up. Runs ON THE DAPP'S OWN
 * infrastructure (their keys, their participant) — the reporting side
 * is key-less and lives elsewhere.
 *
 * Per agreement and tick:
 *   1. accrued = floor(elapsed / period) × ratePerPeriod   (Stepped)
 *   2. due     = accrued − settled                          (arrears-aware)
 *   3. if due > 0 (catch-up) or exactly one period (skip-missed policy):
 *        settle via the token-standard V1 transfer-instruction lane
 *        (registry choice context + disclosed contracts; direct delivery
 *        through the client's TransferPreapproval), stamped with
 *        cantonstreams.dev/{ref,app,agreement} metadata;
 *        then record on the on-ledger StreamAdmin via Sync_Iteration.
 *
 * Field-validated flow: docs/reports/mainnet-external-stream-2026-06-10.md.
 *
 * ## Agreements file (JSON)
 * {
 *   "agreements": [{
 *     "agreementId": "lock-2026-001",
 *     "appId": "my-dapp",
 *     "payerParty": "payer::1220…",
 *     "recipientParty": "client::1220…",
 *     "ratePerPeriod": "10.0",
 *     "cadence": "hourly" | "daily",
 *     "effectiveFrom": "2026-07-01T00:00:00Z",
 *     "termEnd": "2026-08-01T00:00:00Z",          // optional
 *     "arrearsPolicy": "catch-up" | "skip-missed", // default catch-up
 *     "streamAdminCid": "00…"                      // optional on-ledger record
 *   }]
 * }
 *
 * ## Usage
 *   CANTON_JSON_API_URL=http://<participant>:7575 \
 *   CANTON_LEDGER_TOKEN=…            # or CANTON_USER_ID when auth is off \
 *   REGISTRY_API_URL=https://scan.<net>.global.canton.network.sync.global \
 *   CC_ADMIN_PARTY=<dso-party> \
 *   AGREEMENTS_FILE=./agreements.json \
 *   STATE_FILE=./scheduler-state.json \
 *   [TICK_SECONDS=60] [DRY_RUN=true] [ONCE=true] \
 *   node scripts/interest-stream-scheduler.mjs
 *
 * State (per agreement) persists settled totals + last update ids, so
 * restarts resume cleanly and missed windows are caught up per policy.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const config = {
  apiUrl: env('CANTON_JSON_API_URL', 'http://localhost:7575').replace(/\/+$/, ''),
  ledgerToken: env('CANTON_LEDGER_TOKEN'),
  userId: env('CANTON_USER_ID'),
  registryApiUrl: env('REGISTRY_API_URL').replace(/\/+$/, ''),
  ccAdminParty: env('CC_ADMIN_PARTY'),
  instrumentId: env('INSTRUMENT_ID', 'Amulet'),
  holdingTemplateId: env('HOLDING_TEMPLATE_ID', '#splice-amulet:Splice.Amulet:Amulet'),
  streamAdminTemplateId: env('STREAM_ADMIN_TEMPLATE_ID', '#canton-streams:CantonStreams.Stream.StreamAdmin:StreamAdmin'),
  transferFactoryInterfaceId: env(
    'TRANSFER_FACTORY_INTERFACE_ID',
    '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
  ),
  agreementsFile: env('AGREEMENTS_FILE', './agreements.json'),
  stateFile: env('STATE_FILE', './scheduler-state.json'),
  tickSeconds: Number(env('TICK_SECONDS', '60')),
  dryRun: env('DRY_RUN', 'false') === 'true',
  once: env('ONCE', 'false') === 'true',
  executeBeforeSeconds: Number(env('EXECUTE_BEFORE_SECONDS', '3600')),
};

const PERIOD_MS = { hourly: 3_600_000, daily: 86_400_000 };
const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

function fail(msg) {
  log(`FATAL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers (JSON Ledger API v2 + token-standard registry)
// ---------------------------------------------------------------------------

async function ledger(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.ledgerToken) headers.Authorization = `Bearer ${config.ledgerToken}`;
  const res = await fetch(`${config.apiUrl}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  if (!res.ok) {
    const d = t.length > 900 ? `${t.slice(0, 300)} … ${t.slice(-500)}` : t;
    throw new Error(`${method} ${path} ${res.status}: ${d}`);
  }
  return t ? JSON.parse(t) : {};
}

async function registryPost(path, body) {
  const res = await fetch(`${config.registryApiUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`registry ${path} ${res.status}: ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

let n = 0;
async function submit(tag, actAs, commands, disclosedContracts = []) {
  return ledger('POST', '/v2/commands/submit-and-wait', {
    commands,
    commandId: `interest-${tag}-${Date.now()}-${++n}`,
    actAs, readAs: [],
    ...(config.userId ? { userId: config.userId } : {}),
    ...(disclosedContracts.length ? { disclosedContracts } : {}),
  });
}

async function senderHoldings(party) {
  const { offset } = await ledger('GET', '/v2/state/ledger-end');
  const rows = await ledger('POST', '/v2/state/active-contracts', {
    filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: {
      templateId: config.holdingTemplateId, includeCreatedEventBlob: false } } } }] } } },
    verbose: false, activeAtOffset: offset,
  });
  return rows.map((r) => r.contractEntry?.JsActiveContract).filter(Boolean)
    .filter((a) => a.createdEvent.createArgument.owner === party)
    .map((a) => ({ cid: a.createdEvent.contractId, amount: Number(a.createdEvent.createArgument.amount?.initialAmount ?? 0) }));
}

// ---------------------------------------------------------------------------
// Accrual + policy
// ---------------------------------------------------------------------------

/** Stepped accrual since effectiveFrom, capped at termEnd. */
function accruedAmount(agreement, nowMs) {
  const period = PERIOD_MS[agreement.cadence];
  if (!period) throw new Error(`agreement ${agreement.agreementId}: invalid cadence`);
  const start = Date.parse(agreement.effectiveFrom);
  const end = agreement.termEnd ? Date.parse(agreement.termEnd) : Infinity;
  const elapsed = Math.min(nowMs, end) - start;
  if (elapsed < period) return 0;
  return Math.floor(elapsed / period) * Number(agreement.ratePerPeriod);
}

/** Amount due this tick per the agreement's arrears policy. */
function dueAmount(agreement, settled, nowMs) {
  const arrears = Number((accruedAmount(agreement, nowMs) - settled).toFixed(10));
  if (arrears <= 0) return 0;
  if ((agreement.arrearsPolicy ?? 'catch-up') === 'catch-up') return arrears;
  // skip-missed: pay at most one period per tick; older windows lapse.
  return Math.min(arrears, Number(agreement.ratePerPeriod));
}

// ---------------------------------------------------------------------------
// Settlement (transfer-instruction lane, MainNet-validated)
// ---------------------------------------------------------------------------

async function settleCycle(agreement, amount, cycleNo) {
  const ref = `${agreement.agreementId}:cycle-${cycleNo}`;
  const holdings = await senderHoldings(agreement.payerParty);
  const total = holdings.reduce((s, h) => s + h.amount, 0);
  if (total < amount) {
    throw new Error(`insufficient funds: payer holds ≈${total.toFixed(4)}, cycle needs ${amount}`);
  }
  const transfer = {
    sender: agreement.payerParty,
    receiver: agreement.recipientParty,
    amount: amount.toFixed(10),
    instrumentId: { admin: config.ccAdminParty, id: config.instrumentId },
    requestedAt: new Date(Date.now() - 1000).toISOString(),
    executeBefore: new Date(Date.now() + config.executeBeforeSeconds * 1000).toISOString(),
    inputHoldingCids: holdings.map((h) => h.cid),
    meta: { values: {
      'cantonstreams.dev/ref': ref,
      'cantonstreams.dev/v': '1',
      ...(agreement.appId ? { 'cantonstreams.dev/app': agreement.appId } : {}),
      'cantonstreams.dev/agreement': agreement.agreementId,
    } },
  };
  const fac = await registryPost('/registry/transfer-instruction/v1/transfer-factory', {
    choiceArguments: { expectedAdmin: config.ccAdminParty, transfer,
      extraArgs: { context: { values: {} }, meta: { values: {} } } },
    excludeDebugFields: true,
  });
  const ctx = fac.choiceContext ?? {};
  const ctxData = ctx.choiceContextData ?? {};
  const disclosed = (ctx.disclosedContracts ?? []).map((d) => ({
    templateId: d.templateId, contractId: d.contractId,
    createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId ?? '',
  }));
  const res = await submit(`xfer-${cycleNo}`, [agreement.payerParty], [{
    ExerciseCommand: {
      templateId: config.transferFactoryInterfaceId,
      contractId: fac.factoryId,
      choice: 'TransferFactory_Transfer',
      choiceArgument: { expectedAdmin: config.ccAdminParty, transfer,
        extraArgs: { context: typeof ctxData.values === 'object' ? ctxData : { values: ctxData }, meta: { values: {} } } },
    },
  }], disclosed);
  return { ref, updateId: res.updateId ?? 'n/a' };
}

async function syncStreamAdmin(agreement, amount, updateId) {
  if (!agreement.streamAdminCid) return;
  await submit('sync', [agreement.payerParty], [{
    ExerciseCommand: {
      templateId: config.streamAdminTemplateId,
      contractId: agreement.streamAdminCid,
      choice: 'Sync_Iteration',
      choiceArgument: { iterationAmount: amount.toFixed(10), newAllocationCid: updateId },
    },
  }]);
}

// ---------------------------------------------------------------------------
// State + main loop
// ---------------------------------------------------------------------------

function loadState() {
  return existsSync(config.stateFile)
    ? JSON.parse(readFileSync(config.stateFile, 'utf8'))
    : { agreements: {} };
}
function saveState(state) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

async function tick(state) {
  const { agreements } = JSON.parse(readFileSync(config.agreementsFile, 'utf8'));
  const nowMs = Date.now();
  for (const agreement of agreements ?? []) {
    const id = agreement.agreementId;
    const st = state.agreements[id] ?? { settled: 0, cycles: 0, history: [] };
    state.agreements[id] = st;
    let due;
    try {
      due = dueAmount(agreement, st.settled, nowMs);
    } catch (e) {
      log(`agreement ${id}: ${e.message}`);
      continue;
    }
    if (due <= 0) continue;
    if (config.dryRun) {
      log(`DRY_RUN agreement ${id}: would settle ${due.toFixed(10)} (cycle ${st.cycles + 1})`);
      continue;
    }
    let settledNow;
    try {
      settledNow = await settleCycle(agreement, due, st.cycles + 1);
    } catch (e) {
      log(`agreement ${id}: cycle FAILED — ${String(e.message ?? e).slice(0, 400)} (will retry next tick)`);
      continue;
    }
    // CRITICAL: record the payment BEFORE any secondary step. A failure
    // after the transfer committed must never lead to a re-payment.
    st.settled = Number((st.settled + due).toFixed(10));
    st.cycles += 1;
    st.history.push({ at: new Date().toISOString(), amount: due.toFixed(10), ref: settledNow.ref, updateId: settledNow.updateId });
    if (st.history.length > 500) st.history.splice(0, st.history.length - 500);
    saveState(state);
    log(`agreement ${id}: settled ${due.toFixed(10)} (cycle ${st.cycles})  updateId=${settledNow.updateId}`);
    // On-ledger record is best-effort; a failure here is observability
    // loss, not money loss — never retried with a fresh payment.
    try {
      await syncStreamAdmin(agreement, due, settledNow.updateId);
    } catch (e) {
      log(`agreement ${id}: Sync_Iteration failed (payment recorded; on-ledger record skipped) — ${String(e.message ?? e).slice(0, 250)}`);
    }
  }
}

async function main() {
  if (!config.registryApiUrl) fail('REGISTRY_API_URL required');
  if (!config.ccAdminParty) fail('CC_ADMIN_PARTY required');
  if (!existsSync(config.agreementsFile)) fail(`agreements file not found: ${config.agreementsFile}`);
  const state = loadState();
  log(`interest scheduler started — tick=${config.tickSeconds}s dryRun=${config.dryRun} agreements=${config.agreementsFile}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick(state);
    if (config.once) break;
    await new Promise((r) => setTimeout(r, config.tickSeconds * 1000));
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
