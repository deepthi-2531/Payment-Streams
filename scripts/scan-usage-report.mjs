#!/usr/bin/env node
/**
 * Canton Payment Streams — public-Scan usage collector + per-app report.
 *
 * Discovers Streams usage on PUBLIC Scan data with no privileged access:
 * pages `POST {scan}/api/scan/v2/updates` and counts asset-side settlement
 * events stamped with the Streams attribution metadata:
 *
 *   cantonstreams.dev/ref  = "<streamId>:cycle-<n>"   (always stamped)
 *   cantonstreams.dev/app  = "<integrator app id>"    (per-app attribution)
 *
 * App attribution: the sender party is the real on-chain payer, so the
 * integrator registry (party → app) is AUTHORITATIVE. The operator-stamped
 * cantonstreams.dev/app tag is only used when the payer party is not in the
 * registry, and it is FLAGGED as a tag-mismatch whenever it disagrees with
 * the registry — so an operator cannot relabel another project's real
 * activity without it surfacing in report.tagMismatches. Fallback for
 * unregistered payers is the sender party's namespace prefix.
 *
 * Stream contracts themselves are PRIVATE to their parties (Canton
 * privacy); only the asset legs are publicly visible — see
 * docs/reports/first-dapp-integration-testnet.md §10.
 *
 * ## One-shot window
 *
 *   SCAN_URL=https://scan.sv-1.test.global.canton.network.sync.global \
 *   SINCE=2026-07-01T00:00:00Z UNTIL=2026-08-01T00:00:00Z \
 *   node scripts/scan-usage-report.mjs
 *
 * ## Incremental mode (recommended for 30-day windows — run from cron)
 *
 *   STATE_FILE=./usage-state.json SCAN_URL=… SINCE=<window-start> \
 *   node scripts/scan-usage-report.mjs
 *
 * With STATE_FILE set, the cursor and accumulated evidence persist
 * across runs: each invocation resumes where the last stopped and the
 * report always covers everything collected so far. A daily cron some
 * minutes long replaces a single multi-hour scrape, and the state file
 * doubles as the raw-evidence artifact submitted with the report.
 *
 * Optional:
 *   INTEGRATORS=config/integrators.json   party-prefix/app-id → team mapping
 *   EXCLUDE_PARTIES=affiliates.json       JSON array of party ids (grantee/affiliates)
 *   META_KEY / APP_META_KEY / REF_PATTERN overrides
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const SCAN = env('SCAN_URL').replace(/\/+$/, '');
const SINCE = env('SINCE');
const UNTIL = env('UNTIL', new Date().toISOString());
const META_KEY = env('META_KEY', 'cantonstreams.dev/ref');
const APP_META_KEY = env('APP_META_KEY', 'cantonstreams.dev/app');
const AGREEMENT_META_KEY = env('AGREEMENT_META_KEY', 'cantonstreams.dev/agreement');
const REF_PATTERN = new RegExp(env('REF_PATTERN', ':cycle-\\d+$'));
const MAX_PAGES = Number(env('MAX_PAGES', '2000'));
const STATE_FILE = env('STATE_FILE');
/**
 * Imputed traffic/burn parameters (CIP-104-style bytes × price).
 * TRAFFIC_BYTES_PER_SETTLEMENT defaults to the value measured on MainNet
 * 2026-06-10 via the participant's TrafficControlService (one
 * TransferFactory_Transfer settlement = 19,122 sequenced bytes).
 * Re-measure per network/release and override. Set CC_PRICE_USD from the
 * current round for a CC-denominated column.
 */
const BYTES_PER_SETTLEMENT = Number(env('TRAFFIC_BYTES_PER_SETTLEMENT', '19122'));
const TRAFFIC_PRICE_USD_PER_MB = Number(env('TRAFFIC_PRICE_USD_PER_MB', '60'));
const CC_PRICE_USD = env('CC_PRICE_USD') ? Number(env('CC_PRICE_USD')) : undefined;
const excludeParties = new Set(
  env('EXCLUDE_PARTIES') ? JSON.parse(readFileSync(env('EXCLUDE_PARTIES'), 'utf8')) : [],
);
// Optional registry: { "apps": { "<app-id-or-party-prefix>": { "name": "...", "parties": ["..."] } } }
const integrators = env('INTEGRATORS')
  ? JSON.parse(readFileSync(env('INTEGRATORS'), 'utf8'))
  : { apps: {} };
const partyToApp = new Map();
for (const [appId, info] of Object.entries(integrators.apps ?? {})) {
  for (const p of info.parties ?? []) partyToApp.set(p, appId);
}

/**
 * Attribute a settlement to a project. The sender party is the real on-chain
 * payer whose funds moved, so the registry (payer party → app) is
 * authoritative. The operator-stamped cantonstreams.dev/app tag is only a
 * hint: used when the payer is unregistered, and flagged as a mismatch when it
 * disagrees with the registry, so a relabelled tag cannot silently re-credit
 * another project's real activity.
 */
function attribute(found, registry) {
  const registryApp = registry.get(found.sender);
  const tagApp = found.appMeta;
  if (registryApp) {
    return { app: registryApp, source: 'registry', tagApp, tagMismatch: Boolean(tagApp && tagApp !== registryApp) };
  }
  if (tagApp) {
    return { app: tagApp, source: 'tag', tagApp, tagMismatch: false };
  }
  return { app: (found.sender ?? 'unknown').split('::')[0], source: 'namespace', tagApp, tagMismatch: false };
}

if (!SCAN || !SINCE) {
  console.error('SCAN_URL and SINCE are required. See header for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State (incremental mode)
// ---------------------------------------------------------------------------

/**
 * Synchronizer migrations restart the update stream: the `after` cursor
 * is ordered by (migration_id, record_time), so paging must start at the
 * CURRENT migration or it replays the entire prior-era history (MainNet
 * is past migration 1; TestNet was on 1). Auto-detect: highest migration
 * id that still has records after SINCE. Override with MIGRATION_ID.
 */
async function detectMigrationId() {
  if (env('MIGRATION_ID')) return Number(env('MIGRATION_ID'));
  for (let m = 12; m >= 0; m--) {
    const res = await page({ after_record_time: SINCE, after_migration_id: m });
    if ((res.transactions ?? []).length > 0) return m;
  }
  return 1;
}

const state = STATE_FILE && existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { cursor: { after_record_time: SINCE, after_migration_id: await detectMigrationId() }, scanned: 0, evidence: [] };
console.error(`starting at migration_id=${state.cursor.after_migration_id}, record_time=${state.cursor.after_record_time}`);

function saveState() {
  if (STATE_FILE) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Scan paging
// ---------------------------------------------------------------------------

async function page(after) {
  const body = { page_size: 200, daml_value_encoding: 'compact_json' };
  if (after) body.after = after;
  const res = await fetch(`${SCAN}/api/scan/v2/updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`v2/updates ${res.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

/**
 * Pull the Streams attribution from an event. Two publicly visible
 * shapes carry the stamps:
 *   - allocation-lane: AmuletAllocation CREATE (settlement/leg meta)
 *   - transfer-lane:   TransferFactory_Transfer EXERCISE (transfer.meta)
 */
function attributionOf(ev) {
  const spec = ev.create_arguments?.allocation;
  if (spec) {
    const metaValues = {
      ...(spec.settlement?.meta?.values ?? {}),
      ...(spec.transferLeg?.meta?.values ?? {}),
    };
    const refId = spec.settlement?.settlementRef?.id ?? '';
    const ref = metaValues[META_KEY] ?? (REF_PATTERN.test(refId) ? refId : undefined);
    if (ref) {
      const leg = spec.transferLeg ?? {};
      return {
        ref, appMeta: metaValues[APP_META_KEY], agreement: metaValues[AGREEMENT_META_KEY],
        sender: leg.sender, receiver: leg.receiver, amount: Number(leg.amount ?? 0),
      };
    }
  }
  const xfer = (ev.choice_argument ?? ev.exercise_argument ?? {}).transfer;
  if (xfer?.meta?.values?.[META_KEY]) {
    return {
      ref: xfer.meta.values[META_KEY],
      appMeta: xfer.meta.values[APP_META_KEY],
      agreement: xfer.meta.values[AGREEMENT_META_KEY],
      sender: xfer.sender, receiver: xfer.receiver, amount: Number(xfer.amount ?? 0),
    };
  }
  return undefined;
}

let pages = 0;
outer: while (pages < MAX_PAGES) {
  pages += 1;
  const res = await page(state.cursor);
  const txs = res.transactions ?? [];
  if (!txs.length) break;
  for (const tx of txs) {
    if (tx.record_time > UNTIL) break outer;
    state.scanned += 1;
    for (const ev of Object.values(tx.events_by_id ?? {})) {
      const found = attributionOf(ev);
      if (!found) continue;
      const a = { ...found, ...attribute(found, partyToApp) };
      if (excludeParties.has(a.sender) && excludeParties.has(a.receiver)) {
        state.evidence.push({ ...a, recordTime: tx.record_time, updateId: tx.update_id, excluded: true });
      } else {
        state.evidence.push({ ...a, recordTime: tx.record_time, updateId: tx.update_id });
      }
      break; // one count per transaction
    }
    state.cursor = { after_record_time: tx.record_time, after_migration_id: tx.migration_id ?? 1 };
  }
  saveState();
}
saveState();

// ---------------------------------------------------------------------------
// Per-app rollup
// ---------------------------------------------------------------------------

const apps = new Map();
for (const e of state.evidence) {
  if (e.excluded) continue;
  const a = apps.get(e.app) ?? {
    app: e.app,
    name: integrators.apps?.[e.app]?.name ?? e.app,
    settlements: 0, totalAmount: 0,
    streams: new Set(), senders: new Set(), receivers: new Set(),
    bySource: { registry: 0, tag: 0, namespace: 0 }, tagMismatches: 0,
    firstSeen: e.recordTime, lastSeen: e.recordTime,
  };
  a.settlements += 1;
  a.totalAmount += e.amount;
  a.streams.add(e.ref.replace(/:cycle-\d+$/, ''));
  if (e.sender) a.senders.add(e.sender);
  if (e.receiver) a.receivers.add(e.receiver);
  a.bySource[e.source ?? 'namespace'] += 1;
  if (e.tagMismatch) a.tagMismatches += 1;
  if (e.recordTime < a.firstSeen) a.firstSeen = e.recordTime;
  if (e.recordTime > a.lastSeen) a.lastSeen = e.recordTime;
  apps.set(e.app, a);
}

const perApp = [...apps.values()]
  .map((a) => {
    const trafficBytes = a.settlements * BYTES_PER_SETTLEMENT;
    const trafficUsd = (trafficBytes / 1e6) * TRAFFIC_PRICE_USD_PER_MB;
    return {
      app: a.app, name: a.name,
      settlements: a.settlements,
      totalAmountSettled: Number(a.totalAmount.toFixed(10)),
      distinctStreams: a.streams.size,
      distinctSenders: a.senders.size,
      distinctReceivers: a.receivers.size,
      attributedBy: a.bySource,
      tagMismatches: a.tagMismatches,
      imputedTrafficBytes: trafficBytes,
      imputedTrafficUsd: Number(trafficUsd.toFixed(4)),
      ...(CC_PRICE_USD ? { imputedBurnCc: Number((trafficUsd / CC_PRICE_USD).toFixed(4)) } : {}),
      firstSeen: a.firstSeen, lastSeen: a.lastSeen,
    };
  })
  .sort((x, y) => y.settlements - x.settlements);

// Per-agreement rollup (interest agreements etc. — settlements stamped
// with cantonstreams.dev/agreement).
const agreements = new Map();
for (const e of state.evidence) {
  if (e.excluded || !e.agreement) continue;
  const g = agreements.get(e.agreement) ?? {
    agreement: e.agreement, settlements: 0, totalAmount: 0,
    receivers: new Set(), apps: new Set(),
    firstSeen: e.recordTime, lastSeen: e.recordTime,
  };
  g.settlements += 1;
  g.totalAmount += e.amount;
  if (e.receiver) g.receivers.add(e.receiver);
  g.apps.add(e.app);
  if (e.recordTime < g.firstSeen) g.firstSeen = e.recordTime;
  if (e.recordTime > g.lastSeen) g.lastSeen = e.recordTime;
  agreements.set(e.agreement, g);
}
const perAgreement = [...agreements.values()]
  .map((g) => ({
    agreement: g.agreement,
    settlements: g.settlements,
    totalAmountSettled: Number(g.totalAmount.toFixed(10)),
    apps: [...g.apps],
    distinctReceivers: g.receivers.size,
    firstSeen: g.firstSeen, lastSeen: g.lastSeen,
  }))
  .sort((x, y) => y.settlements - x.settlements);

const included = state.evidence.filter((e) => !e.excluded);
// Settlements whose operator-stamped cantonstreams.dev/app tag disagrees with
// the payer party's registered owner — the attributions a reviewer should
// scrutinise: real on-chain activity credited to a project the payer party
// does not belong to. Attribution itself used the registry, not the tag.
const tagMismatches = included
  .filter((e) => e.tagMismatch)
  .map((e) => ({
    updateId: e.updateId, recordTime: e.recordTime, sender: e.sender,
    registryApp: e.app, tagApp: e.tagApp, ref: e.ref,
  }));
const report = {
  generatedAt: new Date().toISOString(),
  scanUrl: SCAN,
  window: { since: SINCE, until: UNTIL },
  method: {
    metaKey: META_KEY, appMetaKey: APP_META_KEY, refPattern: REF_PATTERN.source,
    excludedParties: excludeParties.size, incremental: Boolean(STATE_FILE),
    attribution: 'registry-first: payer party authoritative; cantonstreams.dev/app tag is a flagged hint',
  },
  networkTransactionsScanned: state.scanned,
  totals: {
    settlements: included.length,
    excludedAsAffiliate: state.evidence.length - included.length,
    amountSettled: Number(included.reduce((s, e) => s + e.amount, 0).toFixed(10)),
    distinctApps: perApp.length,
    distinctStreams: new Set(included.map((e) => e.ref.replace(/:cycle-\d+$/, ''))).size,
    tagMismatches: tagMismatches.length,
  },
  perApp,
  perAgreement,
  tagMismatches,
  evidence: STATE_FILE ? `see ${STATE_FILE}` : state.evidence,
};
console.log(JSON.stringify(report, null, 2));

console.error('\nPer-app usage:');
for (const a of perApp) {
  console.error(`  ${a.name.padEnd(28)} settlements=${String(a.settlements).padStart(5)}  ` +
    `amount=${String(a.totalAmountSettled).padStart(14)}  streams=${a.distinctStreams}  ` +
    `receivers=${a.distinctReceivers}  traffic≈${(a.imputedTrafficBytes / 1000).toFixed(1)}KB/$${a.imputedTrafficUsd}` +
    `${a.imputedBurnCc !== undefined ? `/${a.imputedBurnCc}CC` : ''}  active ${a.firstSeen.slice(0, 10)}→${a.lastSeen.slice(0, 10)}`);
}
if (tagMismatches.length) {
  console.error(`\nWARNING: ${tagMismatches.length} settlement(s) where the cantonstreams.dev/app tag ` +
    `disagrees with the payer party's registered owner. Attribution used the registry (payer party), ` +
    `not the tag — see report.tagMismatches.`);
}
console.error(`\nReproduce with the same env — no privileged access required.`);
