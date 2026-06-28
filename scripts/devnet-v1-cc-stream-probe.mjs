#!/usr/bin/env node
/**
 * Transitional CIP-56 V1 lane probe — one full allocation cycle against
 * a live network (LocalNet / DevNet / TestNet) using the V1 token
 * standard that Canton Coin (Amulet) implements TODAY.
 *
 * Targets the Canton 3.x JSON Ledger API **v2** (`/v2/...`). Run it
 * from a host that can reach the participant (e.g. the validator box,
 * pointing at the participant container).
 *
 * Flow (one withdrawal cycle — V1 has no iteration):
 *
 *   1. Create `StreamAllocationRequestV1` (canton-streams-v1-shim DAR)
 *      for one transfer leg sender → recipient, settlementRef.id =
 *      `<streamId>:cycle-<n>`.
 *   2. Allocate:
 *        - AUTO_ALLOCATE=true (default): query the sender's unlocked CC
 *          holdings, resolve the registry's AllocationFactory via the
 *          token-standard API (Scan for Amulet), exercise
 *          `AllocationFactory_Allocate` as the sender with the registry
 *          choice context + disclosed contracts.
 *        - manual: the sender allocates in their wallet UI; pass
 *          ALLOCATION_CID.
 *   3. Discover the V1 `Allocation` whose settlementRef.id matches.
 *   4. Fetch the `execute-transfer` choice context from the registry
 *      and exercise `Allocation_ExecuteTransfer` with the context in
 *      `extraArgs.context` and the disclosed contracts on the command.
 *   5. Archive the shim request (`ShimArchive`).
 *
 * AUTHORITY NOTE: `Allocation_ExecuteTransfer` is controlled by
 * executor AND sender AND receiver jointly (per AllocationV1). This
 * probe submits with all three in actAs, which works when the parties
 * are co-hosted on one participant (probe setups; same party for all
 * three is also fine). For production topologies, compose the exercise
 * inside a choice on a contract signed by those parties.
 *
 * To empirically test a live deployment's effective execute authority, run
 * with EXECUTE_AUTH_MATRIX=true and distinct sender / receiver / executor
 * parties. The probe will try no-sender actAs sets first, then sender-including
 * fallbacks, and report the first set that actually settles.
 *
 * Usage:
 *
 *   CANTON_JSON_API_URL=http://<participant>:7575 \
 *   REGISTRY_API_URL=https://scan.sv-1.test.global.canton.network.sync.global/api/scan \
 *   CC_ADMIN_PARTY=<dso-party> \
 *   SENDER_PARTY=... RECIPIENT_PARTY=... EXECUTOR_PARTY=... \
 *   AMOUNT=1.0 \
 *   node scripts/devnet-v1-cc-stream-probe.mjs
 *
 *   DRY_RUN=true prints the plan without submitting anything.
 *
 * @deprecated from birth — retired with the V1 lane (see "V1 lane
 * retirement" in CHANGELOG.md).
 */

import { loadLocalScriptConfig } from './local-config.mjs';

const localConfig = loadLocalScriptConfig('devnetV1CcStreamProbe').values;
const env = (name, fallback = '') => String(process.env[name] ?? fallback).trim();

const config = {
  apiUrl: env('CANTON_JSON_API_URL', localConfig.cantonJsonApiUrl ?? 'http://localhost:7575').replace(/\/+$/, ''),
  ledgerToken: env('CANTON_LEDGER_TOKEN'),
  userId: env('CANTON_USER_ID', ''),
  shimPackageRef: env('V1_SHIM_PACKAGE_REF', '#canton-streams-v1-shim'),
  // Token-standard registry API base. For Amulet this is Scan's /api/scan.
  registryApiUrl: env('REGISTRY_API_URL', localConfig.registryApiUrl ?? '').replace(/\/+$/, ''),
  registryToken: env('REGISTRY_API_TOKEN'),
  ccAdminParty: env('CC_ADMIN_PARTY', localConfig.ccAdminParty ?? ''),
  instrumentId: env('INSTRUMENT_ID', 'Amulet'),
  senderParty: env('SENDER_PARTY'),
  recipientParty: env('RECIPIENT_PARTY'),
  executorParty: env('EXECUTOR_PARTY'),
  amount: env('AMOUNT', '1.0'),
  streamId: env('STREAM_ID', `v1-probe-${Date.now()}`),
  cycle: env('CYCLE', '1'),
  autoAllocate: env('AUTO_ALLOCATE', 'true') === 'true',
  /**
   * Skip creating/archiving the on-ledger StreamAllocationRequestV1 shim
   * contract. The allocate → execute-transfer cycle is fully testable
   * without it; use this when the shim DAR cannot be vetted yet (e.g. a
   * participant wedged by pre-existing same-name/version package
   * generations under Canton 3.5 strict vetting validation).
   */
  skipShim: env('SKIP_SHIM', 'false') === 'true',
  allocationCid: env('ALLOCATION_CID'),
  allocationPollSeconds: Number(env('ALLOCATION_POLL_SECONDS', '120')),
  /**
   * Concrete holding template to source escrow funds from. Defaults to
   * Amulet (CC). Template queries beat interface queries here: they
   * dodge the JSON API 200-element list cap (validator operator parties
   * see hundreds of holdings as lock-holders) and the package-name
   * ambiguity when two token-standard generations are vetted.
   */
  holdingTemplateId: env('HOLDING_TEMPLATE_ID', '#splice-amulet:Splice.Amulet:Amulet'),
  /** Registry's concrete V1 allocation template (discovery). */
  allocationTemplate: env('ALLOCATION_TEMPLATE', '#splice-amulet:Splice.AmuletAllocation:AmuletAllocation'),
  allocationInterfaceId: env(
    'V1_ALLOCATION_INTERFACE_ID',
    '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation',
  ),
  allocationFactoryInterfaceId: env(
    'V1_ALLOCATION_FACTORY_INTERFACE_ID',
    '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory',
  ),
  /**
   * Default keeps the historical proven path: all controllers in actAs.
   * EXECUTE_AUTH_MATRIX=true tries smaller actAs sets first, answering whether
   * a receiver-claim UX can settle without sender authority.
   * EXECUTE_ACT_AS="party1,party2" forces one exact actAs set for debugging.
   */
  executeAuthMatrix: env('EXECUTE_AUTH_MATRIX', 'false') === 'true',
  executeActAsOverride: env('EXECUTE_ACT_AS'),
  allocateBeforeSeconds: Number(env('ALLOCATE_BEFORE_SECONDS', '1200')),
  settleBeforeSeconds: Number(env('SETTLE_BEFORE_SECONDS', '1800')),
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
  if (!config.executorParty) errs.push('EXECUTOR_PARTY required');
  if (!config.ccAdminParty) errs.push('CC_ADMIN_PARTY required (instrument admin / DSO party)');
  if (!config.registryApiUrl) errs.push('REGISTRY_API_URL required (token-standard API; Scan /api/scan for Amulet)');
  if (errs.length) {
    errs.forEach((e) => log(`preflight: ${e}`));
    fail('preflight checks failed');
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
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
    // Tapir-style errors put the reason after the echoed body — keep both ends.
    const detail = text.length > 1200 ? `${text.slice(0, 400)} … ${text.slice(-700)}` : text;
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

async function registryPost(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.registryToken) headers.Authorization = `Bearer ${config.registryToken}`;
  const res = await fetch(`${config.registryApiUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`registry ${path} → ${res.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text);
}

const emptyMeta = { values: {} };

function settlementRefId() {
  return `${config.streamId}:cycle-${config.cycle}`;
}

/**
 * Attribution metadata stamped on the allocation's settlement + leg.
 * Asset-side events are visible on public Scan (the DSO is a stakeholder
 * of Amulet contracts), so these keys make Streams usage independently
 * countable (Milestone-5) while the stream contracts stay private.
 */
function attributionMeta() {
  const appId = env('APP_ID', env('CANTON_STREAMS_APP_ID'));
  const agreementId = env('AGREEMENT_ID', env('CANTON_STREAMS_AGREEMENT_ID'));
  return { values: {
    'cantonstreams.dev/ref': settlementRefId(),
    'cantonstreams.dev/v': '1',
    ...(appId ? { 'cantonstreams.dev/app': appId } : {}),
    ...(agreementId ? { 'cantonstreams.dev/agreement': agreementId } : {}),
  } };
}

let commandCounter = 0;
function commandId(tag) {
  commandCounter += 1;
  return `v1-probe-${tag}-${Date.now()}-${commandCounter}`;
}

function uniqueParties(parties) {
  return [...new Set(parties.filter(Boolean))];
}

function describeActAs(parties) {
  const labels = [];
  if (parties.includes(config.executorParty)) labels.push('executor');
  if (parties.includes(config.senderParty)) labels.push('sender');
  if (parties.includes(config.recipientParty)) labels.push('receiver');
  return `${labels.join('+') || 'custom'} [${parties.join(', ')}]`;
}

function executeActAsCandidates() {
  if (config.executeActAsOverride) {
    return [
      {
        label: 'override',
        actAs: uniqueParties(config.executeActAsOverride.split(',').map((p) => p.trim())),
      },
    ];
  }
  const all = uniqueParties([config.executorParty, config.senderParty, config.recipientParty]);
  if (!config.executeAuthMatrix) {
    return [{ label: 'all-controllers', actAs: all }];
  }

  return [
    { label: 'executor-only', actAs: uniqueParties([config.executorParty]) },
    { label: 'receiver-only', actAs: uniqueParties([config.recipientParty]) },
    { label: 'executor+receiver', actAs: uniqueParties([config.executorParty, config.recipientParty]) },
    { label: 'sender-only', actAs: uniqueParties([config.senderParty]) },
    { label: 'sender+receiver', actAs: uniqueParties([config.senderParty, config.recipientParty]) },
    { label: 'sender+executor', actAs: uniqueParties([config.senderParty, config.executorParty]) },
    { label: 'all-controllers', actAs: all },
  ];
}

function shortError(err) {
  const msg = err?.message ?? String(err);
  return msg.length > 900 ? `${msg.slice(0, 450)} … ${msg.slice(-350)}` : msg;
}

// ---------------------------------------------------------------------------
// JSON Ledger API v2 helpers
// ---------------------------------------------------------------------------

async function ledgerEnd() {
  const res = await ledger('GET', '/v2/state/ledger-end');
  return res.offset;
}

/**
 * Query active contracts for one party. `idFilter` is either
 * { TemplateFilter } or { InterfaceFilter } per the v2 API.
 */
async function activeContracts(party, idFilter) {
  const offset = await ledgerEnd();
  const res = await ledger('POST', '/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: { cumulative: [{ identifierFilter: idFilter }] },
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
      interfaceViews: ac.createdEvent?.interfaceViews ?? [],
      synchronizerId: ac.synchronizerId,
    }));
}

function templateFilter(templateId) {
  return { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } };
}

function interfaceFilter(interfaceId) {
  return {
    InterfaceFilter: {
      value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false },
    },
  };
}

async function submitAndWait(tag, actAs, commands, disclosedContracts = []) {
  // JsCommands fields live at the top level of the request body.
  const body = {
    commands,
    commandId: commandId(tag),
    actAs,
    readAs: [],
    ...(config.userId ? { userId: config.userId } : {}),
    ...(disclosedContracts.length ? { disclosedContracts } : {}),
  };
  const res = await ledger('POST', '/v2/commands/submit-and-wait', body);
  return res; // { updateId, completionOffset }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function checkSenderHoldings() {
  const holdings = await activeContracts(
    config.senderParty,
    templateFilter(config.holdingTemplateId),
  );
  const owned = holdings.filter((h) => h.payload?.owner === config.senderParty);
  const total = owned.reduce(
    (sum, h) => sum + Number(h.payload?.amount?.initialAmount ?? h.payload?.amount ?? 0),
    0,
  );
  log(`Sender ${config.instrumentId} holdings (${config.holdingTemplateId}): ${owned.length} contracts, total ≈ ${total}`);
  if (total < Number(config.amount)) {
    fail(
      `Sender ${config.senderParty} holds ≈${total} ${config.instrumentId} but the probe needs ${config.amount}. ` +
      'Fund the party and re-run.',
    );
  }
  return owned;
}

function settlementInfo(now) {
  const allocateBefore = new Date(now.getTime() + config.allocateBeforeSeconds * 1000);
  const settleBefore = new Date(now.getTime() + config.settleBeforeSeconds * 1000);
  return {
    executor: config.executorParty,
    settlementRef: { id: settlementRefId(), cid: null },
    requestedAt: now.toISOString(),
    allocateBefore: allocateBefore.toISOString(),
    settleBefore: settleBefore.toISOString(),
    meta: attributionMeta(),
  };
}

function transferLeg() {
  return {
    sender: config.senderParty,
    receiver: config.recipientParty,
    amount: config.amount,
    instrumentId: { admin: config.ccAdminParty, id: config.instrumentId },
    meta: attributionMeta(),
  };
}

async function createShimRequest(now) {
  await submitAndWait('shim-create', [config.executorParty], [{
    CreateCommand: {
      templateId: `${config.shimPackageRef}:CantonStreams.V1Shim.AllocationRequestShim:StreamAllocationRequestV1`,
      createArguments: {
        requestedBy: config.executorParty,
        settlement: settlementInfo(now),
        transferLegs: { 'leg-1': transferLeg() },
        meta: emptyMeta,
      },
    },
  }]);
  // Discover the cid via ACS (avoids depending on transaction-event shape).
  const requests = await activeContracts(
    config.executorParty,
    templateFilter(`${config.shimPackageRef}:CantonStreams.V1Shim.AllocationRequestShim:StreamAllocationRequestV1`),
  );
  const mine = requests.find((r) => r.payload?.settlement?.settlementRef?.id === settlementRefId());
  if (!mine) fail('shim request created but not found in ACS');
  return mine.contractId;
}

function mapDisclosed(ctx) {
  return (ctx.disclosedContracts ?? ctx.disclosed_contracts ?? []).map((dc) => ({
    templateId: dc.templateId ?? dc.template_id,
    contractId: dc.contractId ?? dc.contract_id,
    createdEventBlob: dc.createdEventBlob ?? dc.created_event_blob,
    synchronizerId: dc.synchronizerId ?? dc.synchronizer_id ?? '',
  }));
}

function contextValues(ctx) {
  const data = ctx.choiceContextData ?? ctx.choice_context_data ?? {};
  return typeof data.values === 'object' && data.values !== null ? data : { values: data };
}

async function autoAllocate(now, holdings) {
  const body = await registryPost('/registry/allocation-instruction/v1/allocation-factory', {
    choiceArguments: {
      expectedAdmin: config.ccAdminParty,
      allocation: {
        settlement: settlementInfo(now),
        transferLegId: 'leg-1',
        transferLeg: transferLeg(),
      },
      requestedAt: new Date(now.getTime() - 1000).toISOString(),
      inputHoldingCids: holdings.map((h) => h.contractId),
      extraArgs: { context: { values: {} }, meta: emptyMeta },
    },
    excludeDebugFields: true,
  });
  const factoryId = body.factoryId ?? body.factory_id;
  if (!factoryId) fail(`allocation-factory response missing factoryId: ${JSON.stringify(body).slice(0, 300)}`);
  const ctx = body.choiceContext ?? body.choice_context ?? {};
  const disclosed = mapDisclosed(ctx);
  log(`Registry AllocationFactory: ${factoryId} (${disclosed.length} disclosed contracts)`);
  for (const dc of disclosed) log(`  disclosed: ${dc.templateId}`);

  const res = await submitAndWait('allocate', [config.senderParty], [{
    ExerciseCommand: {
      templateId: config.allocationFactoryInterfaceId,
      contractId: factoryId,
      choice: 'AllocationFactory_Allocate',
      choiceArgument: {
        expectedAdmin: config.ccAdminParty,
        allocation: {
          settlement: settlementInfo(now),
          transferLegId: 'leg-1',
          transferLeg: transferLeg(),
        },
        requestedAt: new Date(now.getTime() - 1000).toISOString(),
        inputHoldingCids: holdings.map((h) => h.contractId),
        extraArgs: { context: contextValues(ctx), meta: emptyMeta },
      },
    },
  }], disclosed);
  log(`AllocationFactory_Allocate submitted (updateId ${res.updateId ?? 'n/a'})`);
}

async function discoverAllocation() {
  if (config.allocationCid) {
    log(`Using ALLOCATION_CID from env: ${config.allocationCid}`);
    return config.allocationCid;
  }
  const deadline = Date.now() + config.allocationPollSeconds * 1000;
  const ref = settlementRefId();
  log(`Polling ACS (${config.allocationTemplate}) for allocation with settlementRef.id = ${ref}…`);
  while (Date.now() < deadline) {
    const allocations = await activeContracts(
      config.senderParty,
      templateFilter(config.allocationTemplate),
    );
    const match = allocations.find((a) => {
      const spec = a.payload?.allocation ?? a.payload?.spec ?? a.payload ?? {};
      return spec.settlement?.settlementRef?.id === ref;
    });
    if (match) return match.contractId;
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail(`No allocation appeared for ${ref} within ${config.allocationPollSeconds}s`);
}

async function executeTransfer(allocationCid) {
  const body = await registryPost(
    `/registry/allocations/v1/${encodeURIComponent(allocationCid)}/choice-contexts/execute-transfer`,
    {},
  );
  const ctx = body.choiceContext ?? body;
  const disclosed = mapDisclosed(ctx);
  log(`execute-transfer choice context fetched (${disclosed.length} disclosed contracts)`);

  const command = {
    ExerciseCommand: {
      templateId: config.allocationInterfaceId,
      contractId: allocationCid,
      choice: 'Allocation_ExecuteTransfer',
      choiceArgument: {
        extraArgs: { context: contextValues(ctx), meta: emptyMeta },
      },
    },
  };

  const parties = uniqueParties([config.executorParty, config.senderParty, config.recipientParty]);
  if (config.executeAuthMatrix && parties.length < 3) {
    log(
      'AUTH MATRIX WARNING — sender, receiver, and executor are not three distinct parties; ' +
      'a success can prove this co-hosted/same-party setup works, but not that a split hosted-wallet topology works.',
    );
  }

  const failures = [];
  for (const candidate of executeActAsCandidates()) {
    log(`AUTH MATRIX TRY ${candidate.label}: ${describeActAs(candidate.actAs)}`);
    try {
      const res = await submitAndWait(
        `execute-${candidate.label}`,
        candidate.actAs,
        [command],
        disclosed,
      );
      log(
        `AUTH MATRIX OK ${candidate.label}: updateId=${res.updateId ?? 'n/a'} ` +
        `actAs=${describeActAs(candidate.actAs)}`,
      );
      return { ...res, executeActAs: candidate.actAs, executeActAsLabel: candidate.label, failures };
    } catch (err) {
      const detail = shortError(err);
      failures.push({ label: candidate.label, actAs: candidate.actAs, error: detail });
      log(`AUTH MATRIX FAIL ${candidate.label}: ${detail}`);
    }
  }

  const summary = failures.map((f) => `${f.label}: ${f.error}`).join('\n');
  throw new Error(`Allocation_ExecuteTransfer failed for every actAs candidate:\n${summary}`);
}

async function archiveShimRequest(requestCid) {
  await submitAndWait('shim-archive', [config.executorParty], [{
    ExerciseCommand: {
      templateId: `${config.shimPackageRef}:CantonStreams.V1Shim.AllocationRequestShim:StreamAllocationRequestV1`,
      contractId: requestCid,
      choice: 'ShimArchive',
      choiceArgument: {},
    },
  }]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  preFlightChecks();
  log('V1 CC stream probe (JSON Ledger API v2) — configuration:');
  log(`  ledger:   ${config.apiUrl}`);
  log(`  registry: ${config.registryApiUrl}`);
  log(`  shim ref: ${config.shimPackageRef}`);
  log(`  leg:      ${config.senderParty} → ${config.recipientParty}, ${config.amount} ${config.instrumentId}`);
  log(`  executor: ${config.executorParty}`);
  log(`  ref:      ${settlementRefId()}`);
  log(
    `  execute:  ${config.executeActAsOverride ? `override ${config.executeActAsOverride}` :
      config.executeAuthMatrix ? 'authority matrix' : 'all controllers'}`,
  );

  if (config.dryRun) {
    log('DRY_RUN=true — printing plan only:');
    log('  1. check sender CC holdings');
    log('  2. create StreamAllocationRequestV1 (shim DAR)');
    log(`  3. ${config.autoAllocate ? 'auto-allocate via registry AllocationFactory' : 'wait for wallet allocation'}`);
    log('  4. fetch execute-transfer choice context from registry');
    log('  5. exercise Allocation_ExecuteTransfer with disclosed contracts');
    for (const c of executeActAsCandidates()) {
      log(`     - candidate ${c.label}: ${describeActAs(c.actAs)}`);
    }
    log('  6. archive the shim request');
    return;
  }

  const version = await ledger('GET', '/v2/version');
  log(`Ledger API: ${version.version}`);

  const holdings = await checkSenderHoldings();

  const now = new Date();
  let requestCid = null;
  if (config.skipShim) {
    log('STEP 1 SKIPPED — SKIP_SHIM=true (no shim request contract)');
  } else {
    requestCid = await createShimRequest(now);
    log(`STEP 1 OK — StreamAllocationRequestV1 created: ${requestCid}`);
  }

  if (config.autoAllocate && !config.allocationCid) {
    await autoAllocate(now, holdings);
    log('STEP 2 OK — allocation submitted via registry AllocationFactory');
  } else {
    log('STEP 2 — waiting for external wallet allocation');
  }

  const allocationCid = await discoverAllocation();
  log(`STEP 3 OK — V1 allocation: ${allocationCid}`);

  const res = await executeTransfer(allocationCid);
  log(`STEP 4 OK — Allocation_ExecuteTransfer executed (updateId ${res.updateId ?? 'n/a'})`);
  if (res.executeActAsLabel) {
    log(`STEP 4 AUTHORITY — first successful actAs candidate: ${res.executeActAsLabel}`);
    log(`STEP 4 AUTHORITY — parties: ${describeActAs(res.executeActAs ?? [])}`);
    if ((res.failures ?? []).length > 0) {
      log('STEP 4 AUTHORITY — failed candidates before success:');
      for (const f of res.failures) log(`  - ${f.label}: ${f.error}`);
    }
  }

  if (requestCid) {
    await archiveShimRequest(requestCid);
    log('STEP 5 OK — shim request archived');
  } else {
    log('STEP 5 SKIPPED — no shim request to archive');
  }
  log('PROBE PASSED — one full V1 cycle settled.');
  log(`Evidence: settlementRef=${settlementRefId()}, executeUpdateId=${res.updateId ?? 'n/a'}`);
  if (res.executeActAsLabel) {
    log(`Authority evidence: executeActAs=${res.executeActAsLabel} (${describeActAs(res.executeActAs ?? [])})`);
  }
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
