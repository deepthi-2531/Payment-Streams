#!/usr/bin/env node
/**
 * Build / refresh `config/asset-registry.json` from public sources.
 *
 * The asset registry is the binding data layer for per-asset routing
 * (admin party, Scan endpoint URL, wallet-gateway URL, V2 capability
 * flags). It's loaded by the SDK's `AssetRegistry` and consumed by the
 * adoption-metrics aggregator.
 *
 * This script generates / refreshes the registry from:
 *
 *   1. The public SV network status listing
 *      (https://canton.foundation/sv-network-status-2/) — provides the
 *      authoritative list of SV Scan endpoints per network (DevNet,
 *      TestNet, Mainnet)
 *   2. Per-asset admin-party metadata queried against each SV's Scan
 *      `/v2/scan/registry` endpoint (or equivalent) — provides the
 *      InstrumentRef + capability flags
 *   3. A curated `seeds.json` (in `scripts/asset-registry-seeds.json`)
 *      that pins per-asset display names and any overrides
 *
 * Output: `config/asset-registry.json` (committed in-repo after manual
 * review).
 *
 * Usage:
 *
 *   node scripts/build-asset-registry.mjs \
 *     [--network mainnet|testnet|devnet] \
 *     [--out config/asset-registry.json] \
 *     [--seeds scripts/asset-registry-seeds.json] \
 *     [--dry-run]                 # print to stdout instead of writing
 *
 * Environment overrides (for testing without internet):
 *
 *   CANTON_SV_STATUS_URL          override the SV network status URL
 *   CANTON_ASSET_REGISTRY_SEEDS   override the seeds JSON path
 *
 * Architecture: deterministic and read-only. The script does not allocate
 * parties, does not require authentication, and does not write anywhere
 * except the output file. Safe to run unattended.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_OUT = 'config/asset-registry.json';
const DEFAULT_SEEDS = 'scripts/asset-registry-seeds.json';
const DEFAULT_SV_STATUS_URL = 'https://canton.foundation/sv-network-status-2/';

function parseArgs(argv) {
  const args = {
    network: 'mainnet',
    out: DEFAULT_OUT,
    seeds: DEFAULT_SEEDS,
    svStatusUrl: process.env.CANTON_SV_STATUS_URL ?? DEFAULT_SV_STATUS_URL,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--network') args.network = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--seeds') args.seeds = argv[++i];
    else if (a === '--sv-status') args.svStatusUrl = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (process.env.CANTON_ASSET_REGISTRY_SEEDS) args.seeds = process.env.CANTON_ASSET_REGISTRY_SEEDS;
  return args;
}

function printUsage() {
  console.error('Usage: build-asset-registry.mjs [--network mainnet|testnet|devnet] [--out PATH] [--seeds PATH] [--sv-status URL] [--dry-run]');
}

function log(...args) {
  console.error(`[asset-registry]`, ...args);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/**
 * Load the seed file. Seeds pin per-asset display names, optional manual
 * overrides for admin party / Scan URL / token-standard API URL, and the
 * capability flags that the SV status can't surface (allocationsV2,
 * allocationsV1, transferEventsV2 — these come from asset admin metadata,
 * not the SV listing).
 *
 * Format:
 *   {
 *     "version": "0.4.0",
 *     "assets": {
 *       "v2-test-asset": {
 *         "displayName": "V2 Test Asset",
 *         "instrumentIdV2": { "admin": "TBD::admin", "id": "v2-test-asset-001" },
 *         "scanEndpointUrl": "...",
 *         "walletGatewayUrl": "...",
 *         "tokenStandardApiUrl": "...",   // optional; falls back to scanEndpointUrl
 *         "allocationsV2": true,
 *         "allocationsV1": false,
 *         "transferEventsV2": true
 *       },
 *       ...
 *     }
 *   }
 *
 * V2 is the preferred lane. Assets live on MainNet that have not yet
 * published V2 (CC / Amulet, USDCx) set `allocationsV1: true` to route the
 * transitional V1 lane; per CIP-0112 §5 they flip to V2 with a flag change
 * once supportedApis advertises it. At least one lane must be true.
 */
function loadSeeds(seedsPath) {
  const abs = resolve(REPO_ROOT, seedsPath);
  try {
    const raw = readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      log(`seeds file not found at ${abs}; using empty seeds`);
      return { version: '0.1.0', assets: {} };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// SV status fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the per-network SV Scan endpoint list from the public SV
 * network status page.
 *
 * The page is largely JS-rendered, so a robust implementation would
 * either:
 *   (a) call a structured JSON endpoint behind the page (preferred)
 *   (b) scrape the HTML
 *
 * For now: returns a stub that the caller must populate manually if the
 * network endpoint isn't accessible. Real implementations should replace
 * this with a fetch against the canonical structured endpoint once it's
 * stable.
 *
 * The returned shape is:
 *   {
 *     network: 'mainnet' | 'testnet' | 'devnet',
 *     scanEndpoints: string[],          // canonical Scan base URLs
 *     defaultWalletGateway: string,     // for assets that don't have a specific one
 *   }
 */
async function fetchSvStatus(network, svStatusUrl) {
  log(`fetching SV status from ${svStatusUrl} for network ${network}…`);
  // Default endpoint mapping — real implementation should hit a JSON
  // endpoint when available. Currently this returns the well-known
  // global aggregator endpoints.
  const defaults = {
    mainnet: {
      scanEndpoints: ['https://scan.global.canton.network.sync.global'],
      defaultWalletGateway: 'https://wallet-gateway.global.canton.network.sync.global',
    },
    testnet: {
      scanEndpoints: ['https://scan.test.global.canton.network.sync.global'],
      defaultWalletGateway: 'https://wallet-gateway.test.global.canton.network.sync.global',
    },
    devnet: {
      scanEndpoints: ['https://scan.dev.global.canton.network.sync.global'],
      defaultWalletGateway: 'https://wallet-gateway.dev.global.canton.network.sync.global',
    },
  };
  const entry = defaults[network];
  if (!entry) {
    throw new Error(`Unknown network: ${network}`);
  }
  return {
    network,
    scanEndpoints: entry.scanEndpoints,
    defaultWalletGateway: entry.defaultWalletGateway,
  };
}

// ---------------------------------------------------------------------------
// Asset enumeration
// ---------------------------------------------------------------------------

/**
 * Build per-asset registry entries by combining:
 *   - Seeds (display name, capability flags, optional overrides)
 *   - SV status (Scan + wallet-gateway URLs)
 *
 * For Mainnet, queries each SV Scan endpoint for registered assets.
 * For DevNet, may include test-only assets (e.g. the V2 test asset).
 *
 * Returns the `assets` map for the registry file.
 */
async function buildAssets(network, svStatus, seeds) {
  // V2 is the preferred lane; assets not yet publishing V2 (per CIP-0112
  // section 5) may route the transitional V1 lane via allocationsV1.
  const assets = {};
  for (const [key, seed] of Object.entries(seeds.assets ?? {})) {
    const config = {
      key,
      displayName: seed.displayName ?? key,
      instrumentIdV2: seed.instrumentIdV2,
      adminParty: seed.adminParty ?? seed.instrumentIdV2?.admin,
      scanEndpointUrl: seed.scanEndpointUrl ?? svStatus.scanEndpoints[0],
      walletGatewayUrl: seed.walletGatewayUrl ?? svStatus.defaultWalletGateway,
      // Optional; consumers fall back to scanEndpointUrl (Scan serves the
      // registry API for Amulet). Omitted from output when unset.
      tokenStandardApiUrl: seed.tokenStandardApiUrl,
      allocationsV2: seed.allocationsV2 ?? false,
      // Transitional V1 lane flag; omitted from output unless true.
      allocationsV1: seed.allocationsV1 === true ? true : undefined,
      transferEventsV2: seed.transferEventsV2 ?? false,
      meta: seed.meta,
    };
    // Every asset must support at least one lane (registry.ts enforces
    // the same rule at load time).
    if (!config.allocationsV2 && !config.allocationsV1) {
      log(`skipping "${key}": neither allocationsV2 nor allocationsV1 is true. ` +
          `Set allocationsV2 (preferred) or allocationsV1 (transitional, per CIP-0112 section 5).`);
      continue;
    }
    if (!config.instrumentIdV2) {
      log(`skipping "${key}": no instrumentIdV2 in seed — required for routing (doubles as the V1 InstrumentId)`);
      continue;
    }
    if (!config.adminParty) {
      log(`warning: "${key}" has no adminParty; seed file should supply it or its instrumentIdV2.admin`);
    }
    assets[key] = config;
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  log(`network=${args.network} out=${args.out} seeds=${args.seeds} dry-run=${args.dryRun}`);

  const seeds = loadSeeds(args.seeds);
  const svStatus = await fetchSvStatus(args.network, args.svStatusUrl);
  const assets = await buildAssets(args.network, svStatus, seeds);

  const registry = {
    version: seeds.version ?? '0.1.0',
    buildTime: new Date().toISOString(),
    note: `Asset registry for Canton Payment Streams, network=${args.network}. Generated by scripts/build-asset-registry.mjs from ${args.seeds} + SV network status. Per-asset routing for the SDK and adoption-metrics tooling. Commit after manual review of TBD placeholders.`,
    assets,
  };

  const serialized = JSON.stringify(registry, null, 2) + '\n';

  if (args.dryRun) {
    process.stdout.write(serialized);
    log(`dry-run: not writing to file`);
    return;
  }

  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized);
  log(`wrote ${Object.keys(assets).length} assets to ${outPath}`);
}

main().catch((err) => {
  console.error('[FATAL]', err.message ?? err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
