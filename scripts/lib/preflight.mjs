/**
 * Shared pre-flight validation for the testnet probe scripts.
 *
 * Every probe (CC, USDCx, V2, V1V2-mixed, future assets) shares the
 * same set of pre-execution checks:
 *
 *   - target network coherence (DevNet / TestNet / Mainnet)
 *   - JSON Ledger API connectivity + auth
 *   - JWT validity (expiry, audience)
 *   - DAR package vetting on the participant
 *   - party-allocation visibility
 *   - asset-registry routing for the asset under test
 *   - placeholder-detection ("TBD::..." values in the registry)
 *
 * The pre-flight returns a `{ ok, errors, warnings }` envelope. Probes
 * call this BEFORE submitting any commands. With `--dry-run`, probes
 * exit after pre-flight without writing anything.
 *
 * Usage:
 *
 *   import { runPreflight, printPreflightReport } from './lib/preflight.mjs';
 *
 *   const report = await runPreflight({
 *     apiUrl: config.apiUrl,
 *     ledgerToken: config.ledgerToken,
 *     packageId: config.packageId,
 *     parties: [sender, recipient, escrowOperator],
 *     assetKey: 'cc',
 *     targetNetwork: 'testnet',
 *     dryRun: args.dryRun,
 *   });
 *   printPreflightReport(report);
 *   if (!report.ok) process.exit(2);
 *   if (args.dryRun) process.exit(0);
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const ASSET_REGISTRY_PATH = resolve(REPO_ROOT, 'config/asset-registry.json');

// ---------------------------------------------------------------------------
// Network heuristics
// ---------------------------------------------------------------------------

const MAINNET_HOST_PATTERNS = [
  /\bglobal\.canton\.network\.sync\.global\b/i,
  /\bcanton-mainnet\b/i,
  /\bmainnet\.canton\b/i,
];

const TESTNET_HOST_PATTERNS = [
  /\btestnet\b/i,
  /\bdevnet\b/i,
  /localhost/i,
  /\b127\.0\.0\.1\b/,
];

function detectNetworkFromUrl(url) {
  for (const p of MAINNET_HOST_PATTERNS) if (p.test(url)) return 'mainnet';
  for (const p of TESTNET_HOST_PATTERNS) if (p.test(url)) return 'testnet-or-devnet';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// JWT decode (no validation — just inspection)
// ---------------------------------------------------------------------------

function decodeJwt(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ledger API probes (read-only)
// ---------------------------------------------------------------------------

async function pingJsonApi(apiUrl, ledgerToken, fetchImpl = fetch) {
  const url = `${apiUrl.replace(/\/+$/, '')}/v2/state/ledger-end`;
  const headers = {};
  if (ledgerToken) headers['authorization'] = `Bearer ${ledgerToken}`;
  const res = await fetchImpl(url, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 100)}`);
  }
}

async function listPackages(apiUrl, ledgerToken, fetchImpl = fetch) {
  const url = `${apiUrl.replace(/\/+$/, '')}/v2/packages`;
  const headers = {};
  if (ledgerToken) headers['authorization'] = `Bearer ${ledgerToken}`;
  const res = await fetchImpl(url, { method: 'GET', headers });
  if (!res.ok) return null; // older participants may not expose this
  try {
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.packageIds)) return data.packageIds;
    if (Array.isArray(data?.packages)) return data.packages.map((p) => p.packageId ?? p);
    return null;
  } catch {
    return null;
  }
}

async function listKnownParties(apiUrl, ledgerToken, fetchImpl = fetch) {
  const url = `${apiUrl.replace(/\/+$/, '')}/v2/parties`;
  const headers = {};
  if (ledgerToken) headers['authorization'] = `Bearer ${ledgerToken}`;
  const res = await fetchImpl(url, { method: 'GET', headers });
  if (!res.ok) return null;
  try {
    const data = await res.json();
    if (Array.isArray(data)) return data.map((p) => p.party ?? p.identifier ?? p);
    if (Array.isArray(data?.partyDetails)) {
      return data.partyDetails.map((p) => p.party ?? p.identifier);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Asset registry inspection
// ---------------------------------------------------------------------------

function loadAssetRegistry() {
  if (!existsSync(ASSET_REGISTRY_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ASSET_REGISTRY_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function findRegistryPlaceholders(asset) {
  const found = [];
  function walk(node, path) {
    if (typeof node === 'string') {
      if (node.startsWith('TBD::') || node.startsWith('TBD-')) {
        found.push({ path: path.join('.'), value: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'meta' || k === 'note') continue;
        walk(v, [...path, k]);
      }
    }
  }
  walk(asset, []);
  return found;
}

// ---------------------------------------------------------------------------
// Main pre-flight entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.apiUrl                   - JSON Ledger API base URL
 * @param {string} [opts.ledgerToken]            - bearer JWT
 * @param {string} [opts.packageId]              - canton-streams main DAR package id
 * @param {string[]} [opts.parties]              - parties this probe will use
 * @param {string} [opts.assetKey]               - asset registry key (e.g. "cc", "usdcx")
 * @param {('devnet'|'testnet'|'mainnet'|'unknown')} [opts.targetNetwork]
 * @param {boolean} [opts.dryRun]                - report only, no commands
 * @param {boolean} [opts.requireExplicitMainnet] - if true, require I_HAVE_MAINNET_CREDENTIALS env var to run on mainnet
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function runPreflight(opts) {
  const errors = [];
  const warnings = [];
  const info = {};

  const apiUrl = opts.apiUrl ?? '';
  const targetNetwork = opts.targetNetwork ?? 'unknown';
  const requireExplicitMainnet = opts.requireExplicitMainnet !== false;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // ---------------------------------------------------------------------
  // 1. Basic env coherence
  // ---------------------------------------------------------------------
  if (!apiUrl) {
    errors.push('apiUrl is required (CANTON_JSON_API_URL env or local-config)');
  }
  if (!opts.packageId) {
    warnings.push(
      'packageId is empty — CANTON_STREAMS_PACKAGE_ID not set. Template ids will resolve via the participant default, but explicit pinning is recommended.',
    );
  }
  const detectedNetwork = detectNetworkFromUrl(apiUrl);
  info.detectedNetwork = detectedNetwork;
  info.targetNetwork = targetNetwork;

  // ---------------------------------------------------------------------
  // 2. Mainnet safety guard
  // ---------------------------------------------------------------------
  if (targetNetwork === 'mainnet' || detectedNetwork === 'mainnet') {
    if (requireExplicitMainnet && process.env.I_HAVE_MAINNET_CREDENTIALS !== 'true') {
      errors.push(
        `Mainnet detected (URL=${apiUrl}, target=${targetNetwork}). Refusing to run without explicit ` +
        `acknowledgment. Set I_HAVE_MAINNET_CREDENTIALS=true to confirm you have a funded wallet and ` +
        `the operator has authorized this run, OR point at a TestNet endpoint.`,
      );
    }
    if (!opts.dryRun) {
      warnings.push(
        'MAINNET TARGET — this probe will move real CC/USDCx. Add --dry-run to verify config without submitting commands.',
      );
    }
  }

  // ---------------------------------------------------------------------
  // 3. URL/target mismatch
  // ---------------------------------------------------------------------
  if (detectedNetwork === 'mainnet' && targetNetwork !== 'mainnet' && targetNetwork !== 'unknown') {
    errors.push(
      `URL ${apiUrl} resolves to mainnet but TARGET_NETWORK=${targetNetwork}. Either the URL or the ` +
      `target setting is wrong. Refusing to proceed.`,
    );
  }
  if (
    detectedNetwork === 'testnet-or-devnet' &&
    targetNetwork === 'mainnet'
  ) {
    errors.push(
      `TARGET_NETWORK=mainnet but URL ${apiUrl} looks like TestNet/DevNet. Mismatched config.`,
    );
  }

  // ---------------------------------------------------------------------
  // 4. JWT validation
  // ---------------------------------------------------------------------
  if (opts.ledgerToken) {
    const payload = decodeJwt(opts.ledgerToken);
    if (!payload) {
      warnings.push('Ledger token is set but does not decode as a JWT — may still work for non-JWT auth.');
    } else {
      info.tokenAudience = payload.aud;
      info.tokenSubject = payload.sub;
      info.tokenExpiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        errors.push(`JWT expired at ${info.tokenExpiresAt}. Refresh CANTON_LEDGER_TOKEN.`);
      } else if (payload.exp && payload.exp - Date.now() / 1000 < 300) {
        warnings.push(`JWT expires in <5 minutes (at ${info.tokenExpiresAt}). Probe may fail mid-run.`);
      }
    }
  } else if (targetNetwork === 'mainnet' || targetNetwork === 'testnet') {
    warnings.push('No CANTON_LEDGER_TOKEN set — mainnet/testnet participants typically require JWT auth.');
  }

  // ---------------------------------------------------------------------
  // 5. JSON Ledger API connectivity
  // ---------------------------------------------------------------------
  if (apiUrl) {
    try {
      const result = await pingJsonApi(apiUrl, opts.ledgerToken, fetchImpl);
      info.ledgerEnd = result?.offset ?? '(unknown)';
    } catch (err) {
      errors.push(`JSON Ledger API not reachable: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // 6. Package vetting check
  // ---------------------------------------------------------------------
  if (opts.packageId && apiUrl && errors.length === 0) {
    try {
      const pkgs = await listPackages(apiUrl, opts.ledgerToken, fetchImpl);
      if (pkgs === null) {
        warnings.push(
          'Could not list participant packages (endpoint may not expose /v2/packages). Skipping vetting check.',
        );
      } else if (!pkgs.includes(opts.packageId)) {
        errors.push(
          `Package ${opts.packageId} not vetted on this participant. Upload + vet the canton-streams ` +
          `DAR before running the probe.`,
        );
      } else {
        info.packageVetted = true;
      }
    } catch (err) {
      warnings.push(`Package vetting check failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // 7. Party visibility
  // ---------------------------------------------------------------------
  if (opts.parties && opts.parties.length > 0 && apiUrl) {
    try {
      const known = await listKnownParties(apiUrl, opts.ledgerToken, fetchImpl);
      if (known === null) {
        warnings.push(
          'Could not list participant parties — endpoint may not expose /v2/parties. Skipping party-visibility check.',
        );
      } else {
        const unknown = opts.parties.filter(
          (p) => p && !known.some((k) => k === p || k?.startsWith(`${p.split('::')[0]}::`)),
        );
        if (unknown.length > 0) {
          warnings.push(
            `Parties not visible to this participant: ${unknown.join(', ')}. Either allocate them ` +
            `or check that PROXY_SERVICE_TOKEN has admin scope.`,
          );
        }
      }
    } catch (err) {
      warnings.push(`Party visibility check failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // 8. Asset registry routing
  // ---------------------------------------------------------------------
  if (opts.assetKey) {
    const registry = loadAssetRegistry();
    if (!registry) {
      warnings.push(`config/asset-registry.json not found or unreadable — skipping asset-routing check.`);
    } else {
      const asset = registry.assets?.[opts.assetKey];
      if (!asset) {
        errors.push(
          `Asset "${opts.assetKey}" not in config/asset-registry.json. Add it before running this probe.`,
        );
      } else {
        info.asset = {
          key: opts.assetKey,
          displayName: asset.displayName,
          allocationsV2: asset.allocationsV2,
          transferEventsV2: asset.transferEventsV2,
        };
        const placeholders = findRegistryPlaceholders(asset);
        if (placeholders.length > 0) {
          const severity = targetNetwork === 'mainnet' ? errors : warnings;
          severity.push(
            `Asset "${opts.assetKey}" has ${placeholders.length} placeholder value(s): ` +
            placeholders.map((p) => `${p.path}=${p.value}`).join(', ') +
            (targetNetwork === 'mainnet'
              ? '. Populate from the SV network status (https://canton.foundation/sv-network-status-2/) before mainnet runs.'
              : '. OK for DevNet; populate before mainnet.'),
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info,
  };
}

// ---------------------------------------------------------------------------
// Pretty-print
// ---------------------------------------------------------------------------

export function printPreflightReport(report, { stream = process.stderr } = {}) {
  const w = (s) => stream.write(s + '\n');
  w('');
  w('────────── Pre-flight ──────────');
  for (const [k, v] of Object.entries(report.info ?? {})) {
    if (v === undefined || v === null) continue;
    w(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  if (report.warnings.length > 0) {
    w('');
    w('  Warnings:');
    for (const w_ of report.warnings) w(`    ⚠ ${w_}`);
  }
  if (report.errors.length > 0) {
    w('');
    w('  Errors:');
    for (const e of report.errors) w(`    ✗ ${e}`);
  }
  w('');
  w(report.ok ? '  ✓ pre-flight passed' : '  ✗ pre-flight FAILED');
  w('──────────────────────────────────');
  w('');
}

// ---------------------------------------------------------------------------
// CLI args helper
// ---------------------------------------------------------------------------

/**
 * Parse common probe CLI flags. Returns:
 *   { dryRun, target, json, raw }
 * `raw` is the remaining argv for probe-specific flags.
 */
export function parseCommonArgs(argv) {
  const remaining = [];
  let dryRun = false;
  let json = false;
  let target = String(process.env.TARGET_NETWORK ?? 'unknown').toLowerCase();

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else if (a === '--target') target = (argv[++i] ?? 'unknown').toLowerCase();
    else remaining.push(a);
  }

  if (!['devnet', 'testnet', 'mainnet', 'unknown'].includes(target)) {
    console.error(`Invalid --target ${target}. Must be one of: devnet, testnet, mainnet.`);
    process.exit(2);
  }

  return { dryRun, target, json, raw: remaining };
}
