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
 *     "operatorParty": "operator::1220…",         // optional; controls Sync_Iteration (default payerParty)
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
 *   [EVENTS_WEBHOOK_URL=https://… EVENTS_WEBHOOK_SECRET=…]   # monitoring \
 *   [RUNWAY_ALERT_DAYS=3] [RUNWAY_ALERT_COOLDOWN_HOURS=6] \
 *   [LOCK_FILE=./scheduler-state.json.lock] \
 *   node scripts/interest-stream-scheduler.mjs
 *
 * State (per agreement) persists settled totals + last update ids, so
 * restarts resume cleanly and missed windows are caught up per policy.
 *
 * Monitoring events (when EVENTS_WEBHOOK_URL is set): cycle.settled,
 * cycle.failed, arrears.accumulated (catch-up spans >1 period),
 * runway.low (payer balance below RUNWAY_ALERT_DAYS of committed daily
 * outflow). Each POST carries `x-sis-event` and an HMAC header
 * `x-sis-signature: sha256=<hex>` over the JSON body. Event delivery is
 * fire-and-forget — it never affects settlement.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHmac } from 'node:crypto';

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
  // Optional monitoring webhook (HMAC-signed; same wire format the
  // streams-interest reporting service verifies: x-sis-event +
  // x-sis-signature: sha256=<hex>). Unset = events disabled.
  eventsWebhookUrl: env('EVENTS_WEBHOOK_URL'),
  eventsWebhookSecret: env('EVENTS_WEBHOOK_SECRET'),
  runwayAlertDays: Number(env('RUNWAY_ALERT_DAYS', '3')),
  runwayAlertCooldownHours: Number(env('RUNWAY_ALERT_COOLDOWN_HOURS', '6')),
  lockFile: env('LOCK_FILE') || `${env('STATE_FILE', './scheduler-state.json')}.lock`,
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
// Monitoring events (optional webhook)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget monitoring event. Delivery failure is logged, never
 * thrown — monitoring must not affect settlement.
 */
async function emitEvent(type, agreement, data) {
  if (!config.eventsWebhookUrl) return;
  const payload = JSON.stringify({
    type,
    agreementId: agreement?.agreementId ?? '',
    appId: agreement?.appId ?? '',
    at: new Date().toISOString(),
    data,
  });
  const headers = { 'Content-Type': 'application/json', 'x-sis-event': type };
  if (config.eventsWebhookSecret) {
    headers['x-sis-signature'] =
      `sha256=${createHmac('sha256', config.eventsWebhookSecret).update(payload).digest('hex')}`;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const res = await fetch(config.eventsWebhookUrl, {
          method: 'POST', headers, body: payload, redirect: 'error', signal: ac.signal,
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500) break; // won't improve on retry
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // network error — one more attempt, then give up
    }
  }
  log(`event ${type} not delivered to webhook (settlement unaffected)`);
}

// ---------------------------------------------------------------------------
// Single-instance lock — two schedulers sharing one state file would not
// lose money (payments are recorded before secondary steps) but would
// race the file and double-log; refuse to start instead.
// ---------------------------------------------------------------------------

function acquireLock() {
  try {
    writeFileSync(config.lockFile, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(config.lockFile, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive) fail(`another scheduler (pid ${pid}) holds ${config.lockFile}`);
    log(`stale lock from pid ${pid} — taking over`);
    writeFileSync(config.lockFile, String(process.pid));
  }
  const release = () => { try { unlinkSync(config.lockFile); } catch { /* gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
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

/**
 * Resolve the CURRENT StreamAdmin cid for an agreement by streamId.
 * Sync_Iteration consumes and recreates the contract, so any stored cid
 * goes stale after one sync — the ACS is the only reliable source.
 * When duplicates exist, the most-progressed one (numIterations) is the
 * live chain.
 */
async function resolveStreamAdminCid(agreement) {
  // ACS filters take package-NAME ids; commands take pinned package ids.
  const [, mod, ent] = config.streamAdminTemplateId.split(':');
  const filterId = config.streamAdminTemplateId.startsWith('#')
    ? config.streamAdminTemplateId : `#canton-streams:${mod}:${ent}`;
  const { offset } = await ledger('GET', '/v2/state/ledger-end');
  const rows = await ledger('POST', '/v2/state/active-contracts', {
    filter: { filtersByParty: { [agreement.payerParty]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: {
      templateId: filterId, includeCreatedEventBlob: false } } } }] } } },
    verbose: false, activeAtOffset: offset,
  });
  // Stream ids are caller-supplied and NOT globally unique, so filtering by
  // streamId alone can resolve a different stream's admin contract that the
  // payer happens to observe. Pin the match to this agreement's full identity
  // (streamId + sender + recipient), then take the most-progressed chain, with
  // a deterministic tie-break (lexically-first operator) when iterations tie.
  const matches = rows
    .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
    .filter((e) =>
      e?.createArgument?.streamId === agreement.agreementId
      && e?.createArgument?.sender === agreement.payerParty
      && e?.createArgument?.recipient === agreement.recipientParty)
    .sort((a, b) => Number(b.createArgument.numIterations ?? 0) - Number(a.createArgument.numIterations ?? 0));
  if (matches.length <= 1) return matches[0]?.contractId;
  const top = Number(matches[0].createArgument.numIterations ?? 0);
  return matches
    .filter((e) => Number(e.createArgument.numIterations ?? 0) === top)
    .sort((a, b) =>
      String(a.createArgument.operator ?? '').localeCompare(String(b.createArgument.operator ?? '')))[0]
    ?.contractId;
}

async function syncStreamAdmin(agreement, amount, updateId) {
  if (!agreement.streamAdminCid) return;
  const cid = (await resolveStreamAdminCid(agreement)) ?? agreement.streamAdminCid;
  // Sync_Iteration is `controller operator` — NOT the payer. Submit as the
  // StreamAdmin operator (e.g. the escrow/executor party for dashboard-created
  // streams); fall back to the payer for legacy streams where operator==payer.
  const operator = agreement.operatorParty ?? agreement.payerParty;
  await submit('sync', [operator], [{
    ExerciseCommand: {
      templateId: config.streamAdminTemplateId,
      contractId: cid,
      choice: 'Sync_Iteration',
      // Full StreamAdmin choice argument. `expectedIteration` and `settledAt`
      // are opt-in guards (None = legacy behaviour) but must be present as
      // record fields to match the canonical Daml/SDK signature.
      choiceArgument: {
        iterationAmount: amount.toFixed(10),
        newAllocationCid: updateId,
        expectedIteration: null,
        settledAt: null,
      },
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

/**
 * Per-payer runway check: wallet balance vs the payer's total committed
 * daily outflow → `runway.low` once per cooldown window when below the
 * threshold. Read-only; an alert must fire before the first failed cycle.
 */
async function checkRunway(state, agreements, nowMs) {
  const byPayer = new Map();
  for (const a of agreements) {
    if (!PERIOD_MS[a.cadence]) continue;
    if (a.termEnd && Date.parse(a.termEnd) <= nowMs) continue;
    const daily = Number(a.ratePerPeriod) * (86_400_000 / PERIOD_MS[a.cadence]);
    const cur = byPayer.get(a.payerParty) ?? { dailyOutflow: 0, agreements: [] };
    cur.dailyOutflow += daily;
    cur.agreements.push(a);
    byPayer.set(a.payerParty, cur);
  }
  state.runwayAlerts ??= {};
  for (const [payer, { dailyOutflow, agreements: payerAgreements }] of byPayer) {
    if (dailyOutflow <= 0) continue;
    let balance;
    try {
      balance = (await senderHoldings(payer)).reduce((s, h) => s + h.amount, 0);
    } catch (e) {
      log(`runway check ${payer.slice(0, 24)}…: holdings query failed — ${String(e.message ?? e).slice(0, 200)}`);
      continue;
    }
    const runwayDays = balance / dailyOutflow;
    if (runwayDays >= config.runwayAlertDays) continue;
    const lastAt = Date.parse(state.runwayAlerts[payer] ?? 0) || 0;
    if (nowMs - lastAt < config.runwayAlertCooldownHours * 3_600_000) continue;
    state.runwayAlerts[payer] = new Date(nowMs).toISOString();
    saveState(state);
    log(`RUNWAY LOW ${payer.slice(0, 24)}…: balance ≈${balance.toFixed(4)} covers ${runwayDays.toFixed(2)} days (threshold ${config.runwayAlertDays})`);
    await emitEvent('runway.low', payerAgreements[0], {
      payerParty: payer,
      balance: balance.toFixed(10),
      dailyOutflow: dailyOutflow.toFixed(10),
      runwayDays: Number(runwayDays.toFixed(2)),
      thresholdDays: config.runwayAlertDays,
      agreementIds: payerAgreements.map((a) => a.agreementId),
    });
  }
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
    // Catch-up spanning more than one period = an outage accumulated
    // arrears; surface it before settlement so monitoring sees the gap
    // even if the catch-up payment itself then fails.
    if (due > Number(agreement.ratePerPeriod) * 1.5) {
      await emitEvent('arrears.accumulated', agreement, {
        arrears: due.toFixed(10),
        periods: Math.round(due / Number(agreement.ratePerPeriod)),
      });
    }
    if (config.dryRun) {
      log(`DRY_RUN agreement ${id}: would settle ${due.toFixed(10)} (cycle ${st.cycles + 1})`);
      continue;
    }
    let settledNow;
    try {
      settledNow = await settleCycle(agreement, due, st.cycles + 1);
    } catch (e) {
      log(`agreement ${id}: cycle FAILED — ${String(e.message ?? e).slice(0, 400)} (will retry next tick)`);
      await emitEvent('cycle.failed', agreement, {
        cycle: st.cycles + 1,
        amount: due.toFixed(10),
        error: String(e.message ?? e).slice(0, 300),
      });
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
    await emitEvent('cycle.settled', agreement, {
      cycle: st.cycles,
      amount: due.toFixed(10),
      ref: settledNow.ref,
      updateId: settledNow.updateId,
    });
    // On-ledger record is best-effort; a failure here is observability
    // loss, not money loss — never retried with a fresh payment.
    try {
      await syncStreamAdmin(agreement, due, settledNow.updateId);
    } catch (e) {
      log(`agreement ${id}: Sync_Iteration failed (payment recorded; on-ledger record skipped) — ${String(e.message ?? e).slice(0, 250)}`);
    }
  }
  await checkRunway(state, agreements ?? [], nowMs);
}

async function main() {
  if (!config.registryApiUrl) fail('REGISTRY_API_URL required');
  if (!config.ccAdminParty) fail('CC_ADMIN_PARTY required');
  if (!existsSync(config.agreementsFile)) fail(`agreements file not found: ${config.agreementsFile}`);
  acquireLock();
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
