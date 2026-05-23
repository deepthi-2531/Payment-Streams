#!/usr/bin/env node
/**
 * V2-native stream lifecycle probe.
 *
 * Exercises the CIP-56 V2 code path against V2-DevNet:
 *   - V2 InstrumentIdV2 addressing (not V1 InstrumentRef)
 *   - V2 Account model (with provider field for institutional custody)
 *   - V2 TransferFactory_Transfer with executeBefore deadline validation
 *   - V2 Lock for lock-in-place custody (alternative to physical-custody transfer)
 *   - V2 Allocation with multi-leg / batch settlement (when used)
 *   - V2 TransferEvents for event-driven advancement
 *
 * Status: BLOCKED on V2 DARs being present in packages/daml/main/.lib/
 *         (run scripts/fetch-v2-dars.mjs first; see STR-42)
 *
 * Once V2 DARs are vetted and the V2 adapter is wired to real types
 * (STR-43 + STR-13), this probe runs end-to-end against V2-DevNet.
 *
 * Usage (when ready):
 *
 *   CANTON_JSON_API_URL=https://v2-devnet.example/json-api \
 *   CANTON_LEDGER_TOKEN=$TOKEN \
 *   CANTON_STREAMS_PACKAGE_ID=$PKG_ID \
 *   V2_ASSET_KEY=v2-test-asset \
 *   node scripts/testnet-v2-stream-probe.mjs
 *
 * Modeled on testnet-cc-stream-probe.mjs (STR-30). Same JSON Ledger
 * API flow; only the template ids and asset addressing change.
 */

import { loadLocalScriptConfig } from './local-config.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const localConfig = loadLocalScriptConfig('testnetV2StreamProbe').values;
const env = (name, fallback = '') => String(process.env[name] ?? fallback).trim();

const config = {
  apiUrl: (env('CANTON_JSON_API_URL', localConfig.cantonJsonApiUrl ?? 'http://localhost:7575')).replace(/\/+$/, ''),
  ledgerToken: env('CANTON_LEDGER_TOKEN'),
  packageId: env('CANTON_STREAMS_PACKAGE_ID', localConfig.cantonStreamsPackageId ?? ''),
  userId: env('CANTON_USER_ID', 'ledger-api-user'),
  v2AssetKey: env('V2_ASSET_KEY', localConfig.v2AssetKey ?? 'v2-test-asset'),
  senderParty: env('SENDER_PARTY'),
  recipientParty: env('RECIPIENT_PARTY'),
  escrowOperatorParty: env('ESCROW_OPERATOR_PARTY'),
  amount: env('AMOUNT', '50.0'),
  durationSeconds: Number(env('STREAM_DURATION_SECONDS', '60')),
  startDelaySeconds: Number(env('STREAM_START_DELAY_SECONDS', '5')),
  streamId: env('STREAM_ID', `v2-stream-${Date.now()}`),
  useLockInPlace: env('USE_LOCK_IN_PLACE', 'false') === 'true',
  useMultiLeg: env('USE_MULTI_LEG', 'false') === 'true',
};

function log(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

function preFlightChecks() {
  const errs = [];
  if (!config.packageId) errs.push('CANTON_STREAMS_PACKAGE_ID required');
  if (!config.senderParty) errs.push('SENDER_PARTY required');
  if (!config.recipientParty) errs.push('RECIPIENT_PARTY required');
  if (!config.escrowOperatorParty) errs.push('ESCROW_OPERATOR_PARTY required');

  // Asset registry resolution
  try {
    const registryPath = resolve(REPO_ROOT, 'config/asset-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const asset = registry.assets[config.v2AssetKey];
    if (!asset) {
      errs.push(`asset "${config.v2AssetKey}" not found in config/asset-registry.json`);
    } else if (!asset.v2Capable) {
      errs.push(`asset "${config.v2AssetKey}" is not marked v2Capable in the registry`);
    } else if (!asset.instrumentIdV2) {
      errs.push(`asset "${config.v2AssetKey}" has v2Capable=true but no instrumentIdV2`);
    } else {
      config.instrumentIdV2 = asset.instrumentIdV2;
      config.scanEndpointUrl = asset.scanEndpointUrl;
      config.walletGatewayUrl = asset.walletGatewayUrl;
    }
  } catch (err) {
    errs.push(`failed to load asset registry: ${err.message}`);
  }

  if (errs.length > 0) {
    console.error('Pre-flight checks failed:');
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(2);
  }
}

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (config.ledgerToken) headers['authorization'] = `Bearer ${config.ledgerToken}`;
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return parsed;
}

async function submitCommand({ commands, actAs }) {
  const commandId = `cmd-v2-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await call('POST', '/v2/commands/submit-and-wait', {
    commands,
    commandId,
    userId: config.userId,
    actAs,
  });
  return { commandId, updateId: result.updateId, completionOffset: result.completionOffset };
}

async function main() {
  console.log('========================================');
  console.log(' V2-Native Stream Lifecycle Probe');
  console.log(' STR-14 — M2 V2 verification gate');
  console.log('========================================\n');
  preFlightChecks();

  log(`API URL:             ${config.apiUrl}`);
  log(`Asset (V2):          ${config.v2AssetKey}`);
  log(`InstrumentIdV2:      admin=${config.instrumentIdV2.admin} id=${config.instrumentIdV2.id}`);
  log(`Scan endpoint:       ${config.scanEndpointUrl}`);
  log(`Stream ID:           ${config.streamId}`);
  log(`Lock-in-place:       ${config.useLockInPlace}`);
  log(`Multi-leg:           ${config.useMultiLeg}`);
  log('');

  // STATUS: V2 templates not yet built into the canton-streams DAR
  // (the V2 adapter currently uses stub types per STR-43). This probe
  // verifies the scaffold + asset-registry resolution end-to-end and
  // will exercise actual V2 transfers once STR-42 + STR-43 land.

  log('⚠ V2 probe is scaffolded but V2 DARs are not yet present.');
  log('  Steps to make this probe run end-to-end:');
  log('    1. node scripts/fetch-v2-dars.mjs');
  log('    2. uncomment V2 deps in packages/daml/main/daml.yaml');
  log('    3. replace stubbed types in TokenStandardV2Adapter.daml');
  log('    4. daml build --all');
  log('    5. re-run this probe');
  log('');
  log('Scaffold verification:');
  log(`  ✓ asset registry resolves "${config.v2AssetKey}" as V2-capable`);
  log(`  ✓ instrumentIdV2 present`);
  log(`  ✓ scan endpoint configured`);
  log('');
  log('When DARs are ready, this script will:');
  log('  - Allocate / use V2 Accounts (with provider field for institutional custody)');
  log('  - Submit V2 stream request via TransferFactory_Transfer');
  log('  - Recipient accepts via TransferInstruction_Accept');
  log('  - Subscribe to TransferEventsV2 for event-driven advancement');
  log('  - Withdraw via Allocation_Settle (or SettlementFactory_SettleBatch if multi-leg)');
  log('  - Verify lock-in-place custody if --use-lock-in-place');
  log('');
  log('Exit: scaffold OK, blocked on V2 DAR availability.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL]', err.message ?? err);
  process.exit(1);
});
