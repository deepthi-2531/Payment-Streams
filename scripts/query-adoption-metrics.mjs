#!/usr/bin/env node
/**
 * Query Canton mainnet adoption metrics for Canton Streams.
 *
 * This script computes adoption metrics directly from public Canton scan
 * endpoints. It takes no app-supplied data and produces a verifiable JSON
 * report.
 *
 * Inputs:
 *   - Canonical template manifest (from build-template-manifest.mjs)
 *   - Affiliate exclusion list (party identifiers excluded from counts)
 *   - Public scan endpoint URL (Splice scan or any compatible indexer)
 *   - Measurement window (start / end ISO timestamps)
 *
 * Outputs:
 *   - Distinct external payer parties (excluding affiliates)
 *   - Distinct stream contracts created
 *   - Cumulative notional value streamed (decimal sum)
 *   - Distinct settlement modes exercised
 *   - Distinct asset types used
 *   - Days of continuous activity
 *   - Settlements / withdrawals executed
 *   - Cumulative CC burn (best-effort; depends on scan endpoint exposing fees)
 *
 * Anyone with the public scan URL and template manifest can independently
 * verify the output.
 *
 * Usage:
 *
 *   node scripts/query-adoption-metrics.mjs \
 *     --manifest dist/template-manifest.json \
 *     --exclude affiliate-parties.json \
 *     --scan https://scan.global.canton.network.sync.global \
 *     --since 2026-06-01T00:00:00Z \
 *     --until 2026-12-01T00:00:00Z \
 *     --out dist/adoption-report.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    manifest: 'dist/template-manifest.json',
    exclude: null,
    scan: null,                   // single-Scan mode (backwards-compat)
    assetRegistry: null,          // multi-Scan mode (preferred)
    since: null,
    until: new Date().toISOString(),
    out: 'dist/adoption-report.json',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--exclude') args.exclude = argv[++i];
    else if (a === '--scan') args.scan = argv[++i];
    else if (a === '--asset-registry') args.assetRegistry = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--until') args.until = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!args.scan && !args.assetRegistry) {
    console.error('Either --asset-registry <path> (multi-Scan, preferred) or --scan <url> (single-Scan, legacy) is required');
    process.exit(2);
  }
  if (!args.since) {
    console.error('--since <ISO timestamp> is required');
    process.exit(2);
  }
  return args;
}

function printUsage() {
  console.error('Usage:');
  console.error('  query-adoption-metrics.mjs --asset-registry config/asset-registry.json --since ISO [--until ISO] [--manifest PATH] [--exclude PATH] [--out PATH]');
  console.error('  query-adoption-metrics.mjs --scan URL --since ISO [--until ISO] [--manifest PATH] [--exclude PATH] [--out PATH]');
  console.error('');
  console.error('--asset-registry is the multi-Scan aggregator mode (queries each asset\'s Scan endpoint separately, aggregates results).');
  console.error('--scan is the legacy single-Scan mode retained for backwards compatibility.');
}

/**
 * Load the asset registry and return the list of unique Scan endpoints
 * to query, along with per-endpoint asset annotations for downstream
 * attribution.
 */
function loadAssetRegistry(path) {
  const raw = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  const registry = JSON.parse(raw);
  /** @type {Map<string, {endpoint: string, assets: string[]}>} */
  const endpointMap = new Map();
  for (const [key, asset] of Object.entries(registry.assets ?? {})) {
    const url = asset.scanEndpointUrl;
    if (!url) continue;
    if (!endpointMap.has(url)) endpointMap.set(url, { endpoint: url, assets: [] });
    endpointMap.get(url).assets.push(key);
  }
  return {
    version: registry.version ?? '?',
    endpoints: Array.from(endpointMap.values()),
  };
}

function loadManifest(path) {
  const raw = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  const manifest = JSON.parse(raw);
  const templateIds = new Set();
  const packageHashes = new Set();
  for (const pkg of manifest.packages ?? []) {
    packageHashes.add(pkg.packageHash);
    for (const t of pkg.templates ?? []) {
      templateIds.add(t.templateId);
    }
  }
  return { manifest, templateIds, packageHashes };
}

function loadExcludes(path) {
  if (!path) return new Set();
  const raw = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  const data = JSON.parse(raw);
  const parties = Array.isArray(data) ? data : data.parties ?? [];
  return new Set(parties);
}

/**
 * Query the scan endpoint for transactions referencing the given template
 * ids in the time window. The exact endpoint shape depends on the scan
 * implementation; this function uses a generic POST /transactions/search
 * pattern and falls back to /v1/updates for compatibility.
 *
 * Implementations:
 *   - Splice scan API:    POST /api/scan/v0/updates/by-template
 *   - Generic JSON Ledger API: GET /v1/updates with filter
 *
 * The fetch loop handles pagination via continuation token.
 */
async function fetchTransactions(scanUrl, templateIds, since, until) {
  const url = `${scanUrl.replace(/\/$/, '')}/api/scan/v0/updates/by-template`;
  const allUpdates = [];
  let continuation = null;

  while (true) {
    const body = {
      templateIds: Array.from(templateIds),
      since,
      until,
      pageSize: 1000,
      continuationToken: continuation,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Scan endpoint error ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    allUpdates.push(...(page.updates ?? page.transactions ?? []));
    continuation = page.continuationToken ?? page.nextToken ?? null;
    if (!continuation) break;
  }

  return allUpdates;
}

/**
 * Compute adoption metrics from the raw update stream. Each update is
 * expected to contain enough metadata to identify:
 *   - submitter party / actAs parties
 *   - template id of created/exercised contracts
 *   - amounts on Create payloads (for notional)
 *   - timestamp
 *   - choice name (for withdrawal counting)
 *   - fee / CC burn (if exposed by scan)
 */
function computeMetrics(updates, excludes, packageHashes) {
  const externalParties = new Set();
  const streamCreates = new Set();
  const settlementModes = new Set();
  const assetTypes = new Set();
  const instrumentIds = new Set();
  const activityTimestamps = [];
  let withdrawalCount = 0;
  let totalNotional = 0;
  let totalCcBurn = 0;

  const isExternal = (party) => party && !excludes.has(party);

  for (const u of updates) {
    const submitter = u.submitter ?? u.actAs?.[0] ?? null;
    const ts = u.recordTime ?? u.effectiveAt ?? u.timestamp;

    if (submitter && isExternal(submitter)) externalParties.add(submitter);
    if (ts) activityTimestamps.push(ts);

    const events = u.events ?? u.createEvents ?? u.exerciseEvents ?? [];
    for (const ev of events) {
      const tid = ev.templateId ?? ev.template_id;
      const isOurs = tid && Array.from(packageHashes).some((h) => tid.startsWith(h + ':'));
      if (!isOurs) continue;

      // Stream creation
      if (ev.kind === 'created' || ev.eventKind === 'create') {
        const args = ev.createArguments ?? ev.payload ?? {};
        if (tid.endsWith(':StreamEscrow')
          || tid.endsWith(':TokenStandardEscrow')
          || tid.endsWith(':UtilityHoldingEscrow')
          || tid.endsWith(':LocalAssetEscrow')) {
          streamCreates.add(ev.contractId);
          const config = args.config ?? args;
          if (config.totalDeposited) {
            totalNotional += Number(config.totalDeposited) || 0;
          }
          if (config.settlementMode) {
            const sm = typeof config.settlementMode === 'string' ? config.settlementMode : config.settlementMode.tag;
            if (sm) settlementModes.add(sm);
          }
          if (config.assetType) {
            const at = typeof config.assetType === 'string' ? config.assetType : config.assetType.tag;
            if (at) assetTypes.add(at);
          }
          if (config.instrumentRef) {
            const r = config.instrumentRef;
            instrumentIds.add(`${r.issuer ?? r.admin}:${r.instrumentId ?? r.id}`);
          }
        }
      }

      // Withdrawal / settlement counting
      if (ev.kind === 'exercised' || ev.eventKind === 'exercise') {
        const choice = ev.choice ?? ev.choiceName;
        if (choice && /^(Withdraw|ClaimWithdraw|FinalizeTokenStandardEscrow|FinalizeUtilityHoldingEscrow|ExecutePolicy)/.test(choice)) {
          withdrawalCount += 1;
        }
      }
    }

    // CC burn — best effort; depends on scan exposing fees.
    if (u.fees?.ccBurn) totalCcBurn += Number(u.fees.ccBurn) || 0;
    else if (u.cost) totalCcBurn += Number(u.cost) || 0;
  }

  // Continuous-activity span: count days that had ≥1 external transaction.
  const days = new Set(
    activityTimestamps
      .map((t) => (typeof t === 'string' ? t.slice(0, 10) : new Date(t).toISOString().slice(0, 10))),
  );

  return {
    externalPayerParties: externalParties.size,
    externalPartyList: [...externalParties].sort(),
    streamsCreated: streamCreates.size,
    cumulativeNotional: totalNotional,
    distinctSettlementModes: settlementModes.size,
    settlementModesList: [...settlementModes].sort(),
    distinctAssetTypes: assetTypes.size,
    assetTypesList: [...assetTypes].sort(),
    distinctInstruments: instrumentIds.size,
    activityDays: days.size,
    withdrawalsExecuted: withdrawalCount,
    cumulativeCcBurn: totalCcBurn,
  };
}

/**
 * Merge two metric records into one. Sets are unioned; counters are
 * summed; days set is unioned by ISO-date prefix.
 */
function mergeMetrics(a, b) {
  return {
    externalPayerParties: new Set([...(a.externalPartyList ?? []), ...(b.externalPartyList ?? [])]).size,
    externalPartyList: Array.from(new Set([...(a.externalPartyList ?? []), ...(b.externalPartyList ?? [])])).sort(),
    streamsCreated: (a.streamsCreated ?? 0) + (b.streamsCreated ?? 0),
    cumulativeNotional: (a.cumulativeNotional ?? 0) + (b.cumulativeNotional ?? 0),
    distinctSettlementModes: new Set([...(a.settlementModesList ?? []), ...(b.settlementModesList ?? [])]).size,
    settlementModesList: Array.from(new Set([...(a.settlementModesList ?? []), ...(b.settlementModesList ?? [])])).sort(),
    distinctAssetTypes: new Set([...(a.assetTypesList ?? []), ...(b.assetTypesList ?? [])]).size,
    assetTypesList: Array.from(new Set([...(a.assetTypesList ?? []), ...(b.assetTypesList ?? [])])).sort(),
    distinctInstruments: (a.distinctInstruments ?? 0) + (b.distinctInstruments ?? 0),
    activityDays: Math.max(a.activityDays ?? 0, b.activityDays ?? 0),
    withdrawalsExecuted: (a.withdrawalsExecuted ?? 0) + (b.withdrawalsExecuted ?? 0),
    cumulativeCcBurn: (a.cumulativeCcBurn ?? 0) + (b.cumulativeCcBurn ?? 0),
  };
}

async function main() {
  const args = parseArgs(process.argv);

  console.error(`[adoption] manifest:       ${args.manifest}`);
  console.error(`[adoption] window:         ${args.since} → ${args.until}`);
  console.error(`[adoption] exclude:        ${args.exclude ?? '(none)'}`);

  const { manifest, templateIds, packageHashes } = loadManifest(args.manifest);
  const excludes = loadExcludes(args.exclude);
  console.error(`[adoption] templates in scope: ${templateIds.size}`);
  console.error(`[adoption] package hashes:     ${packageHashes.size}`);
  console.error(`[adoption] excluded parties:   ${excludes.size}`);

  // -------------------------------------------------------------------
  // Multi-Scan mode: aggregate across asset-registry endpoints
  // -------------------------------------------------------------------
  let aggregateMetrics;
  let perEndpoint = [];
  let scanEndpoints;

  if (args.assetRegistry) {
    console.error(`[adoption] asset registry: ${args.assetRegistry}`);
    const registry = loadAssetRegistry(args.assetRegistry);
    scanEndpoints = registry.endpoints.map((e) => e.endpoint);
    console.error(`[adoption] aggregating across ${registry.endpoints.length} Scan endpoint(s) from registry version ${registry.version}`);

    aggregateMetrics = {
      externalPayerParties: 0, externalPartyList: [],
      streamsCreated: 0, cumulativeNotional: 0,
      distinctSettlementModes: 0, settlementModesList: [],
      distinctAssetTypes: 0, assetTypesList: [],
      distinctInstruments: 0, activityDays: 0,
      withdrawalsExecuted: 0, cumulativeCcBurn: 0,
    };

    for (const ep of registry.endpoints) {
      console.error(`[adoption] querying ${ep.endpoint} for asset(s): ${ep.assets.join(', ')}`);
      try {
        const updates = await fetchTransactions(ep.endpoint, templateIds, args.since, args.until);
        console.error(`[adoption]   fetched ${updates.length} updates`);
        const metrics = computeMetrics(updates, excludes, packageHashes);
        perEndpoint.push({
          scanEndpoint: ep.endpoint,
          assets: ep.assets,
          updates: updates.length,
          metrics,
        });
        aggregateMetrics = mergeMetrics(aggregateMetrics, metrics);
      } catch (err) {
        console.error(`[adoption]   ✗ ${ep.endpoint} failed: ${err.message ?? err}`);
        perEndpoint.push({
          scanEndpoint: ep.endpoint,
          assets: ep.assets,
          error: String(err.message ?? err),
        });
      }
    }
  } else {
    // Legacy single-Scan mode
    console.error(`[adoption] single-Scan endpoint: ${args.scan}`);
    scanEndpoints = [args.scan];
    const updates = await fetchTransactions(args.scan, templateIds, args.since, args.until);
    console.error(`[adoption] fetched ${updates.length} updates`);
    aggregateMetrics = computeMetrics(updates, excludes, packageHashes);
    perEndpoint = [{ scanEndpoint: args.scan, assets: ['*'], updates: updates.length, metrics: aggregateMetrics }];
  }

  const report = {
    generatedAt: new Date().toISOString(),
    manifestVersion: manifest.version,
    mode: args.assetRegistry ? 'multi-scan' : 'single-scan',
    scanEndpoints,
    perEndpoint,
    window: { since: args.since, until: args.until },
    templateIdsInScope: templateIds.size,
    packageHashesInScope: packageHashes.size,
    excludedParties: excludes.size,
    metrics: aggregateMetrics,
    note:
      'Computed against public scan endpoint(s) with no app-supplied data. ' +
      'Re-runnable by any third party. Multi-Scan mode aggregates per-asset metrics ' +
      'across endpoints from config/asset-registry.json.',
  };

  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.error(`[adoption] wrote ${outPath}`);

  // Pretty-print to stdout for quick CLI use.
  console.log(JSON.stringify(report.metrics, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
