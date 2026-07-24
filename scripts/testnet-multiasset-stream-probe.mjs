#!/usr/bin/env node
/**
 * Multi-asset V1 payment-stream probe (proxy REST API).
 *
 * Exercises one V1 payment stream for an ARBITRARY whitelisted asset end to end
 * through the streams proxy's REST surface (NOT the JSON Ledger API directly),
 * then exercises the offer-expiry claim-back path. Everything the proxy touches
 * on-ledger is confirmed on the global Scan, so the probe credits the ledger,
 * never a stored figure.
 *
 * Flow:
 *
 *   1. POST /api/v1/streams { payerParty, recipientParty, ratePerCycle, cadence,
 *      assetKey } as the payer. Asserts 201, OR reports a clean 400
 *      `unknown_asset` when ASSET_KEY is not a whitelisted asset-registry key.
 *   2. POST /api/v1/streams/:id/settle (force) to settle one cycle now. Reports
 *      whether the cycle DELIVERED directly (recipient pre-approved) or landed as
 *      a PENDING OFFER the recipient must accept (state.pendingTransfers[]).
 *   3. Claim-back (only when the cycle is a pending offer AND CLAIM_BACK=true):
 *      poll GET /api/v1/streams/:id until the offer's `executeBefore` has passed
 *      (the on-ledger accept deadline — an expired offer can no longer be
 *      accepted), then POST /api/v1/streams/:id/prepare-withdraw to form the
 *      sender's TransferInstruction_Withdraw. If WITHDRAW_UPDATE_ID is supplied
 *      (the updateId of the payer WALLET's submission of that prepared command),
 *      POST /api/v1/streams/:id/record-withdraw — which Scan-verifies the offer
 *      was consumed and marks the funds reclaimed. Optionally corroborates via a
 *      direct GET {scan}/api/scan/v2/updates/{id}.
 *
 * The proxy submits the create + settle for a payer hosted on its own
 * participant (dev/hosted topology). The claim-back is the prepare→record pair:
 * a REST probe cannot forge the payer wallet's ledger tx, so recording the
 * reclaim needs the wallet-submitted updateId (WITHDRAW_UPDATE_ID). Without it,
 * the probe drives prepare-withdraw and reports the ready-to-submit command.
 *
 * ## Usage
 *
 *   PROXY_BASE_URL=http://127.0.0.1:4000 \
 *   ASSET_KEY=usdcx \
 *   PAYER_PARTY=... RECIPIENT_PARTY=... \
 *   AMOUNT=10.0 \
 *   node scripts/testnet-multiasset-stream-probe.mjs
 *
 *   DRY_RUN=true prints the plan without mutating anything.
 *
 * ## Environment
 *
 *   PROXY_BASE_URL        Streams proxy REST base (default http://localhost:4000)
 *   ASSET_KEY             Whitelisted asset-registry key (default 'cc')
 *   PAYER_PARTY           Payer / sender party id (required; SENDER_PARTY alias)
 *   RECIPIENT_PARTY       Recipient party id (required)
 *   AMOUNT                Rate per cycle (default 10.0)
 *   CADENCE               second | minute | hourly | daily (default 'daily')
 *   STREAM_ID             Stream id (default multiasset-probe-<ts>)
 *   CLAIM_BACK            'true' to exercise the offer-expiry claim-back path
 *   WITHDRAW_UPDATE_ID    updateId of the wallet-submitted withdraw (records reclaim)
 *   SCAN_API_URL          Scan base for the evidence GET (REGISTRY_API_URL alias);
 *                         the probe calls {scan}/api/scan/v2/updates/{id}
 *   PROXY_AUTH_TOKEN      Optional Bearer JWT for the proxy (CANTON_LEDGER_TOKEN alias)
 *   SETTLE_FORCE          'false' to settle only when a cycle is actually due
 *                         (default 'true' — settle one cycle on demand)
 *   POLL_INTERVAL_MS      Expiry poll interval (default 5000)
 *   CLAIM_BACK_TIMEOUT_S  Max seconds to wait for the offer to expire (default 900)
 *   DRY_RUN               'true' prints the plan without mutating
 *
 * Auth follows the sibling probes' dev-auth posture: the caller party is sent in
 * the `X-Canton-Party` header (the proxy's dev-mode identity), plus an optional
 * `Authorization: Bearer` token. No hosts, parties, or ids are hardcoded here.
 */

import { loadLocalScriptConfig } from './local-config.mjs';

const localConfig = loadLocalScriptConfig('testnetMultiassetStreamProbe').values;
const env = (name, fallback = '') => String(process.env[name] ?? fallback).trim();

const config = {
  proxyBaseUrl: env('PROXY_BASE_URL', localConfig.proxyBaseUrl ?? 'http://localhost:4000').replace(/\/+$/, ''),
  proxyToken: env('PROXY_AUTH_TOKEN', env('CANTON_LEDGER_TOKEN')),
  assetKey: env('ASSET_KEY', 'cc'),
  payerParty: env('PAYER_PARTY', env('SENDER_PARTY')),
  recipientParty: env('RECIPIENT_PARTY'),
  amount: env('AMOUNT', '10.0'),
  cadence: env('CADENCE', 'daily'),
  streamId: env('STREAM_ID', `multiasset-probe-${Date.now()}`),
  claimBack: env('CLAIM_BACK', 'false') === 'true',
  withdrawUpdateId: env('WITHDRAW_UPDATE_ID'),
  // Scan base (WITHOUT /api/scan) for the corroborating evidence GET. Strip a
  // trailing /api/scan if the operator passed the registry form of the URL, so
  // both `https://scan…` and `https://scan…/api/scan` work.
  scanApiUrl: env('SCAN_API_URL', env('REGISTRY_API_URL', localConfig.registryApiUrl ?? ''))
    .replace(/\/+$/, '')
    .replace(/\/api\/scan$/, ''),
  settleForce: env('SETTLE_FORCE', 'true') !== 'false',
  pollIntervalMs: Number(env('POLL_INTERVAL_MS', '5000')),
  claimBackTimeoutS: Number(env('CLAIM_BACK_TIMEOUT_S', '900')),
  dryRun: env('DRY_RUN', 'false') === 'true',
};

function log(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

function fail(msg) {
  log(`FAIL: ${msg}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preFlightChecks() {
  const errs = [];
  if (!config.payerParty) errs.push('PAYER_PARTY (or SENDER_PARTY) required');
  if (!config.recipientParty) errs.push('RECIPIENT_PARTY required');
  if (config.payerParty && config.payerParty === config.recipientParty) {
    errs.push('PAYER_PARTY and RECIPIENT_PARTY must differ');
  }
  if (!['second', 'minute', 'hourly', 'daily'].includes(config.cadence)) {
    errs.push(`CADENCE must be second|minute|hourly|daily, got "${config.cadence}"`);
  }
  if (config.claimBack && !config.scanApiUrl && config.withdrawUpdateId) {
    log('note: SCAN_API_URL not set — skipping the corroborating direct Scan GET (record-withdraw still Scan-verifies server-side).');
  }
  if (errs.length) {
    errs.forEach((e) => log(`preflight: ${e}`));
    fail('preflight checks failed');
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Call the proxy REST API as `actingParty`. Dev-auth posture: identity travels
 * in the `X-Canton-Party` header (plus an optional Bearer token). Returns
 * `{ status, ok, body }` where body is the parsed JSON (or `{ raw }`).
 */
async function proxy(method, path, { party, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (party) headers['X-Canton-Party'] = party;
  if (config.proxyToken) headers.Authorization = `Bearer ${config.proxyToken}`;
  const res = await fetch(`${config.proxyBaseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/**
 * Fetch a committed update from the global Scan for corroborating evidence,
 * mirroring the proxy's own lookup: GET {scan}/api/scan/v2/updates/{updateId}.
 * Polls briefly to absorb Scan ingestion lag. Best-effort — the authoritative
 * Scan check is the one record-withdraw performs server-side.
 */
async function scanUpdate(updateId) {
  if (!config.scanApiUrl) return null;
  const url = `${config.scanApiUrl}/api/scan/v2/updates/${encodeURIComponent(updateId)}`;
  const attempts = 8;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      log(`  Scan fetch error (attempt ${i + 1}/${attempts}): ${String(e?.message ?? e).slice(0, 120)}`);
      await sleep(2500);
      continue;
    }
    if (res.status === 404) {
      await sleep(2500);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      log(`  Scan ${res.status}: ${text.slice(0, 120)}`);
      await sleep(2500);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Read the stream's current pending offers (status === 'pending') via GET detail. */
async function readPendingOffers(streamId) {
  const res = await proxy('GET', `/api/v1/streams/${encodeURIComponent(streamId)}`, {
    party: config.payerParty,
  });
  if (!res.ok) {
    fail(`GET /api/v1/streams/${streamId} → ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  const pending = res.body?.state?.pendingTransfers ?? [];
  return pending.filter((p) => p.status === 'pending');
}

async function main() {
  preFlightChecks();
  log('Multi-asset V1 stream probe (proxy REST) — configuration:');
  log(`  proxy:      ${config.proxyBaseUrl}`);
  log(`  scan:       ${config.scanApiUrl || '(none — direct Scan evidence GET disabled)'}`);
  log(`  asset key:  ${config.assetKey}`);
  log(`  leg:        ${config.payerParty} → ${config.recipientParty}, ${config.amount}/${config.cadence}`);
  log(`  stream id:  ${config.streamId}`);
  log(`  claim-back: ${config.claimBack}${config.claimBack && config.withdrawUpdateId ? ` (withdraw updateId ${config.withdrawUpdateId})` : ''}`);

  if (config.dryRun) {
    log('DRY_RUN=true — printing plan only:');
    log(`  1. POST /api/v1/streams { payerParty, recipientParty, ratePerCycle: ${config.amount}, cadence: ${config.cadence}, assetKey: ${config.assetKey} }`);
    log('     → assert 201, or report a clean 400 unknown_asset if the asset is not whitelisted');
    log(`  2. POST /api/v1/streams/${config.streamId}/settle (force=${config.settleForce}) → settle one cycle`);
    log('     → report DELIVERED (pre-approved recipient) vs PENDING OFFER (state.pendingTransfers)');
    if (config.claimBack) {
      log('  3. claim-back (pending offer only):');
      log(`     a. poll GET /api/v1/streams/${config.streamId} until the offer's executeBefore has passed`);
      log(`     b. POST /api/v1/streams/${config.streamId}/prepare-withdraw → assert prepared:true`);
      if (config.withdrawUpdateId) {
        log(`     c. POST /api/v1/streams/${config.streamId}/record-withdraw { updateId: ${config.withdrawUpdateId} } → assert withdrawn:true (Scan-verified reclaim)`);
        if (config.scanApiUrl) log(`     d. GET ${config.scanApiUrl}/api/scan/v2/updates/${config.withdrawUpdateId} → corroborating evidence`);
      } else {
        log('     c. (no WITHDRAW_UPDATE_ID) → report the prepared withdraw command; recording the reclaim needs the wallet-submitted updateId');
      }
    } else {
      log('  3. claim-back skipped (CLAIM_BACK != true)');
    }
    return;
  }

  // 1. Create the stream ------------------------------------------------------
  log('STEP 1 — POST /api/v1/streams …');
  const create = await proxy('POST', '/api/v1/streams', {
    party: config.payerParty,
    body: {
      streamId: config.streamId,
      payerParty: config.payerParty,
      recipientParty: config.recipientParty,
      ratePerCycle: config.amount,
      cadence: config.cadence,
      assetKey: config.assetKey,
    },
  });

  if (create.status === 400 && create.body?.reason === 'unknown_asset') {
    log('');
    log(`ASSET NOT WHITELISTED — the proxy rejected assetKey "${config.assetKey}" with a clean 400 unknown_asset:`);
    log(`  ${create.body.error ?? '(no error message)'}`);
    log('This is the expected whitelist-gate response for an asset that is not in config/asset-registry.json.');
    log('PROBE COMPLETE — whitelist gate verified (no stream created).');
    return;
  }

  if (create.status !== 201) {
    fail(`create expected 201, got ${create.status}: ${JSON.stringify(create.body).slice(0, 400)}`);
  }
  const streamId = create.body?.agreement?.agreementId ?? config.streamId;
  log(`STEP 1 OK — V1 stream created (201): ${streamId}, asset=${create.body?.agreement?.assetKey ?? config.assetKey}`);

  // 2. Settle one cycle -------------------------------------------------------
  log(`STEP 2 — POST /api/v1/streams/${streamId}/settle (force=${config.settleForce}) …`);
  const settle = await proxy('POST', `/api/v1/streams/${encodeURIComponent(streamId)}/settle`, {
    party: config.payerParty,
    body: { force: config.settleForce },
  });
  if (!settle.ok) {
    fail(`settle failed → ${settle.status}: ${JSON.stringify(settle.body).slice(0, 400)}`);
  }
  const outcome = settle.body ?? {};

  // The settle outcome tells us directly; the GET detail is the durable record.
  let pendingOffer = outcome.pending ?? null;
  if (!pendingOffer) {
    const offers = await readPendingOffers(streamId);
    // Bind to this cycle when the outcome names it, else take the latest pending.
    pendingOffer =
      offers.find((o) => outcome.cycle !== undefined && o.cycle === outcome.cycle) ??
      offers[offers.length - 1] ??
      null;
  }

  if (outcome.settled) {
    log(`STEP 2 OK — cycle DELIVERED directly (recipient pre-approved). cycle=${outcome.cycle ?? '?'}, amount=${outcome.amount ?? config.amount}, updateId=${outcome.updateId ?? 'n/a'}`);
  } else if (pendingOffer) {
    log(`STEP 2 OK — cycle landed as a PENDING OFFER (recipient has no pre-approval, must accept).`);
    log(`  cycle=${pendingOffer.cycle}, amount=${pendingOffer.amount}, instructionCid=${pendingOffer.transferInstructionCid}`);
    log(`  executeBefore=${pendingOffer.executeBefore} (accept deadline; after this the sender may reclaim)`);
  } else {
    log(`STEP 2 — settle returned settled=false with no pending offer: reason=${outcome.reason ?? 'unknown'} (nothing due, or stream stopped).`);
  }

  // 3. Claim-back (offer expired → sender reclaims funds) ----------------------
  if (!config.claimBack) {
    log('STEP 3 SKIPPED — CLAIM_BACK != true.');
    log(`PROBE COMPLETE — stream ${streamId} settled one cycle.`);
    return;
  }
  if (!pendingOffer) {
    log('STEP 3 SKIPPED — no pending offer to claim back (the cycle delivered directly, or nothing was due).');
    log(`PROBE COMPLETE — stream ${streamId} settled one cycle.`);
    return;
  }

  log('STEP 3 — offer-expiry claim-back:');
  // 3a. Wait until executeBefore has passed. An expired offer can no longer be
  //     accepted by the recipient, so the sender's reclaim is uncontested.
  const deadline = Date.now() + config.claimBackTimeoutS * 1000;
  let expiredOffer = pendingOffer;
  while (Date.parse(expiredOffer.executeBefore) > Date.now()) {
    const waitMs = Date.parse(expiredOffer.executeBefore) - Date.now();
    if (Date.now() + waitMs > deadline) {
      fail(
        `offer executeBefore=${expiredOffer.executeBefore} is ${Math.round(waitMs / 1000)}s away, ` +
        `beyond CLAIM_BACK_TIMEOUT_S=${config.claimBackTimeoutS}. Raise the timeout (or lower the ` +
        `proxy EXECUTE_BEFORE_SECONDS) and re-run.`,
      );
    }
    log(`  waiting ${Math.round(Math.min(waitMs, config.pollIntervalMs) / 1000)}s for the offer to expire (executeBefore=${expiredOffer.executeBefore}) …`);
    await sleep(Math.min(waitMs + 1000, config.pollIntervalMs));
    const offers = await readPendingOffers(streamId);
    const still = offers.find((o) => o.cycle === expiredOffer.cycle);
    if (!still) {
      fail(`offer for cycle ${expiredOffer.cycle} is no longer pending (accepted or withdrawn out-of-band); nothing to claim back.`);
    }
    expiredOffer = still;
  }
  log(`  offer for cycle ${expiredOffer.cycle} is EXPIRED (executeBefore=${expiredOffer.executeBefore} < now) — the recipient can no longer accept it.`);

  // 3b. Form the sender's TransferInstruction_Withdraw via the proxy.
  log(`  POST /api/v1/streams/${streamId}/prepare-withdraw …`);
  const prep = await proxy('POST', `/api/v1/streams/${encodeURIComponent(streamId)}/prepare-withdraw`, {
    party: config.payerParty,
    body: { transferInstructionCid: expiredOffer.transferInstructionCid, cycle: expiredOffer.cycle },
  });
  if (!prep.ok) {
    fail(`prepare-withdraw failed → ${prep.status}: ${JSON.stringify(prep.body).slice(0, 400)}`);
  }
  if (prep.body?.prepared !== true) {
    fail(`prepare-withdraw returned prepared=false: reason=${prep.body?.reason ?? 'unknown'}`);
  }
  log(`  prepared TransferInstruction_Withdraw for cycle ${prep.body.cycle} (instructionCid=${prep.body.transferInstructionCid}, actAs=${prep.body.actAs}, ${(prep.body.disclosedContracts ?? []).length} disclosed contracts).`);

  // 3c. Record the reclaim once the payer's wallet has submitted the withdraw.
  //     A REST probe cannot forge that ledger tx, so recording needs its
  //     updateId. record-withdraw Scan-verifies the offer was consumed.
  if (!config.withdrawUpdateId) {
    log('  WITHDRAW_UPDATE_ID not set — the prepared withdraw command is ready for the payer wallet to submit.');
    log('  Submit it from the payer wallet, then re-run with WITHDRAW_UPDATE_ID=<updateId> to record + verify the reclaim.');
    log(`PROBE COMPLETE — pending offer for cycle ${expiredOffer.cycle} is expired and the reclaim command is prepared.`);
    return;
  }

  log(`  POST /api/v1/streams/${streamId}/record-withdraw { updateId: ${config.withdrawUpdateId} } …`);
  const rec = await proxy('POST', `/api/v1/streams/${encodeURIComponent(streamId)}/record-withdraw`, {
    party: config.payerParty,
    body: {
      updateId: config.withdrawUpdateId,
      transferInstructionCid: expiredOffer.transferInstructionCid,
      cycle: expiredOffer.cycle,
    },
  });
  if (!rec.ok) {
    fail(`record-withdraw failed → ${rec.status}: ${JSON.stringify(rec.body).slice(0, 400)}`);
  }
  if (rec.body?.withdrawn !== true) {
    fail(`record-withdraw did not reclaim: withdrawn=${rec.body?.withdrawn}, reason=${rec.body?.reason ?? 'unknown'}`);
  }
  log(`  RECLAIMED — cycle ${rec.body.cycle} funds returned to the sender, Scan-verified (updateId=${rec.body.updateId}).`);

  // 3d. Corroborate with a direct Scan lookup (evidence; best-effort).
  const evidence = await scanUpdate(config.withdrawUpdateId);
  if (evidence) {
    const echoed = evidence.update_id ?? evidence.updateId ?? '(id not echoed)';
    log(`  Scan evidence: GET ${config.scanApiUrl}/api/scan/v2/updates/${config.withdrawUpdateId} → committed (update_id=${echoed}).`);
  } else if (config.scanApiUrl) {
    log('  Scan evidence: update not resolvable directly (already asserted server-side by record-withdraw).');
  }

  log(`PROBE PASSED — offer expired → sender reclaimed funds for stream ${streamId}, cycle ${expiredOffer.cycle}.`);
  log(`Evidence: streamId=${streamId}, withdrawUpdateId=${config.withdrawUpdateId}, instructionCid=${expiredOffer.transferInstructionCid}`);
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
