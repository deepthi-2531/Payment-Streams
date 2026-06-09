#!/usr/bin/env node
/**
 * USDCx / production TokenStandardCustody stream lifecycle probe.
 *
 * Despite the filename, this probe handles ANY CIP-56 V1 asset
 * (USDCx, Canton Coin, or any other V1 token-standard asset). Set
 * `INSTRUMENT_ID` + `INSTRUMENT_ADMIN` + `INSTRUMENT_DEPOSITORY` from
 * the asset registry to target a specific asset. Defaults are USDCx.
 *
 * ## Flags (preferred over env when both set)
 *
 *   --dry-run                Pre-flight only; submit no commands.
 *   --target <devnet|testnet|mainnet>  Required network coherence check.
 *   --asset-key <key>        Look up routing from config/asset-registry.json
 *                            (e.g. --asset-key cc / --asset-key usdcx).
 *   --json                   Machine-readable JSON output.
 *
 * ## Required env vars (mainnet / testnet)
 *
 *   CANTON_JSON_API_URL                       JSON Ledger API
 *   CANTON_LEDGER_TOKEN                       JWT auth
 *   CANTON_USER_ID                            ledger user id (default: ledger-api-user)
 *   SYNCHRONIZER_ID                           synchronizer id
 *   CANTON_HOST + CANTON_PORT                 gRPC endpoint
 *   CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID  vetted DAR package id
 *   CANTON_STREAMS_WALLET_GATEWAY_URL         Wallet Gateway dApp API base URL
 *   CANTON_STREAMS_WALLET_GATEWAY_TOKEN       Wallet Gateway session token
 *   SENDER_PARTY                              funded sender wallet (signing handled by gateway)
 *   RECIPIENT_PARTY                           recipient wallet (signing handled by gateway)
 *   ESCROW_PARTY                              service party
 *   INSTRUMENT_ID / INSTRUMENT_ADMIN /        asset routing (or use --asset-key)
 *   INSTRUMENT_DEPOSITORY
 *
 * ## Signing model
 *
 * Previous versions of this probe accepted `SENDER_PRIVATE_KEY` and
 * `RECIPIENT_PRIVATE_KEY` env vars and signed prepared-transaction
 * hashes in-process via `node:crypto`. That path is gone. The Wallet
 * Gateway holds all signing keys and the probe uses the SDK
 * `SigningProvider` to delegate prepare, sign, and execute. The Wallet
 * Gateway connection (URL + session token) is the only signing config
 * the probe needs.
 *
 * ## Mainnet safety
 *
 * Mainnet runs are blocked unless I_HAVE_MAINNET_CREDENTIALS=true is
 * set in addition to --target mainnet. Pre-flight detects placeholder
 * "TBD::..." values in the asset registry and fails on mainnet.
 *
 * See docs/TESTNET-RUNBOOK.md for the full setup walkthrough.
 */

import {
  GrpcTransport,
  createDefaultOrchestrator,
  createLogger,
  createSigningFromEnv,
} from "../packages/sdk/dist/index.js";
import { loadLocalScriptConfig } from "./local-config.mjs";
import { runPreflight, printPreflightReport, parseCommonArgs } from "./lib/preflight.mjs";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const localConfig = loadLocalScriptConfig("testnetTokenStandardStreamProbe").values;

// Parse common CLI flags + probe-specific --asset-key
const cliArgs = parseCommonArgs(process.argv);
let assetKey = null;
for (let i = 0; i < cliArgs.raw.length; i++) {
  if (cliArgs.raw[i] === "--asset-key") {
    assetKey = (cliArgs.raw[++i] ?? "").trim();
    if (!assetKey) {
      console.error("--asset-key requires a value (e.g. cc, usdcx, v2-test-asset)");
      process.exit(2);
    }
  }
}

const config = {
  apiUrl: env("CANTON_JSON_API_URL", localConfig.cantonJsonApiUrl ?? "http://localhost:7575").replace(/\/+$/, ""),
  ledgerToken: env("CANTON_LEDGER_TOKEN", env("LEDGER_TOKEN")),
  commandUserId: env("CANTON_USER_ID", env("COMMAND_USER_ID", "ledger-api-user")),
  synchronizerId: env("SYNCHRONIZER_ID", localConfig.synchronizerId ?? ""),
  cantonHost: env("CANTON_HOST", localConfig.cantonHost ?? "localhost"),
  cantonPort: Number(env("CANTON_PORT", String(localConfig.cantonPort ?? 5001))),
  cantonUseTls: /^(1|true|yes)$/i.test(env("CANTON_USE_TLS", String(localConfig.cantonUseTls ?? false))),
  packageId: env(
    "CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID",
    localConfig.tokenStandardPackageId ?? "",
  ),
  senderParty: env("SENDER_PARTY"),
  recipientParty: env("RECIPIENT_PARTY"),
  // Signing now goes through the Wallet Gateway via SigningProvider.
  // Private key env vars (SENDER_PRIVATE_KEY / RECIPIENT_PRIVATE_KEY) are
  // intentionally NOT read here — the gateway holds the keys.
  escrowParty: env("ESCROW_PARTY"),
  amount: env("DEPOSIT_AMOUNT", env("AMOUNT", "1.0000000000")),
  streamId: env("STREAM_ID", `token-standard-stream-${Date.now()}`),
  streamStartDelaySeconds: Number(env("STREAM_START_DELAY_SECONDS", "5")),
  streamDurationSeconds: Number(env("STREAM_DURATION_SECONDS", "20")),
  withdrawIntervalSeconds: Number(env("WITHDRAW_INTERVAL_SECONDS", "0")),
  vestingMode: env("VESTING_MODE", "Linear"),
  cliffTime: env("CLIFF_TIME", ""),
  stepIntervalMicros: Number(env("STEP_INTERVAL_MICROS", "0")),
  amountPerStep: env("AMOUNT_PER_STEP", ""),
  termDurationMicros: Number(env("TERM_DURATION_MICROS", "0")),
  pollIntervalMs: Number(env("POLL_INTERVAL_MS", "2500")),
  completionTimeoutMs: Number(env("COMPLETION_TIMEOUT_MS", "180000")),
  fundingReference: env("FUNDING_REFERENCE", "hosted-token-standard-transfer"),
  senderAccountRef:
    env(
      "SENDER_ACCOUNT_REF",
      JSON.stringify({
        party: env("SENDER_PARTY"),
        wallet: env("SENDER_WALLET_NAME", localConfig.senderWalletName ?? "host-wallet"),
      }),
    ),
  recipientAccountRef:
    env(
      "RECIPIENT_ACCOUNT_REF",
      JSON.stringify({
        party: env("RECIPIENT_PARTY"),
        wallet: env("RECIPIENT_WALLET_NAME", localConfig.recipientWalletName ?? "host-wallet"),
      }),
    ),
  instrumentId: env("INSTRUMENT_ID", localConfig.instrumentId ?? "USDCx"),
  instrumentVersion: env("INSTRUMENT_VERSION", localConfig.instrumentVersion ?? "testnet"),
  instrumentAdmin: env("INSTRUMENT_ADMIN", localConfig.instrumentAdmin ?? ""),
  instrumentDepository: env("INSTRUMENT_DEPOSITORY", localConfig.instrumentDepository ?? ""),
};

function required(value, name) {
  if (!String(value ?? "").trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function normalizeVestingMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  switch (normalized) {
    case "linear":
      return "Linear";
    case "cliff":
    case "clifflinear":
      return "CliffLinear";
    case "stepped":
      return "Stepped";
    case "renewable":
    case "renewableterm":
      return "RenewableTerm";
    default:
      throw new Error(`Unsupported vesting mode: ${mode}`);
  }
}

function fingerprintFromParty(party) {
  const pieces = String(party || "").split("::");
  return pieces[pieces.length - 1] || "";
}

// signPreparedHash() is gone. The Wallet Gateway signs prepared
// transactions on behalf of the configured party. The probe now calls
// `signingResolver.forParty(party).prepareExecuteAndWait({...})` which
// delegates the entire prepare → sign → execute flow to the gateway.

async function requestLedger(path, { method = "POST", body } = {}) {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ledgerToken}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const rendered = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} ${path}: ${rendered}`);
  }

  return payload;
}

async function getLedgerEnd() {
  const payload = await requestLedger("/v2/state/ledger-end", { method: "GET" });
  const offset = payload?.offset ?? payload?.result?.offset;
  if (offset === undefined || offset === null) {
    throw new Error(`ledger-end response missing offset: ${JSON.stringify(payload)}`);
  }
  return Number(offset);
}

function normalizeTemplateId(templateId) {
  if (!templateId) return "";
  if (typeof templateId === "string") return templateId;
  if (typeof templateId === "object") {
    const packageId =
      templateId.packageId ?? templateId.package_id ?? templateId.package ?? "";
    const moduleName =
      templateId.moduleName ?? templateId.module_name ?? templateId.module ?? "";
    const entityName =
      templateId.entityName ?? templateId.entity_name ?? templateId.entity ?? "";
    return [packageId, moduleName, entityName].filter(Boolean).join(":");
  }
  return String(templateId);
}

function extractCreatedEvents(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.activeContracts)
      ? payload.activeContracts
      : Array.isArray(payload?.result)
        ? payload.result
        : [];

  return raw
    .map((entry) => {
      const created =
        entry?.contractEntry?.JsActiveContract?.createdEvent ??
        entry?.createdEvent ??
        entry?.contractEntry?.createdEvent ??
        null;
      if (!created) return null;
      return {
        contractId: created.contractId ?? created.contract_id ?? "",
        templateId: normalizeTemplateId(created.templateId ?? created.template_id),
        createArguments:
          created.createArguments ??
          created.createArgument ??
          created.create_arguments ??
          {},
      };
    })
    .filter(Boolean);
}

async function queryVisibleContracts(parties) {
  const offset = await getLedgerEnd();
  const filtersByParty = Object.fromEntries(
    parties.map((party) => [
      party,
      {
        cumulative: [
          {
            identifierFilter: {
              WildcardFilter: {
                value: {
                  includeCreatedEventBlob: false,
                },
              },
            },
          },
        ],
      },
    ]),
  );

  const payload = await requestLedger("/v2/state/active-contracts", {
    body: {
      userId: config.commandUserId,
      activeAtOffset: offset,
      filter: { filtersByParty },
    },
  });

  return extractCreatedEvents(payload);
}

async function waitForContract(matchFn, parties, label, attempts = 40) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const events = await queryVisibleContracts(parties);
    const match = events.find(matchFn);
    if (match) {
      log(`${label} Found`, {
        contractId: match.contractId,
        templateId: match.templateId,
        createArguments: match.createArguments,
      });
      return match;
    }

    console.log(`[token-standard-probe] waiting for ${label} (${attempt}/${attempts})`);
    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * prepareAndExecute now delegates to the Wallet Gateway via
 * SigningProvider.prepareExecuteAndWait. The gateway performs the
 * prepare → sign → execute round-trip server-side using whichever
 * signing-provider kind (participant / Fireblocks / Blockdaemon /
 * Dfns / wallet-gateway-internal) holds the party's key.
 *
 * `signingResolver` must be initialized in main() before any call to
 * this function. Closure-captured per the original signature shape so
 * call-sites elsewhere in the probe don't need refactoring.
 */
let _signingResolverHandle = null;

function setSigningResolver(resolver) {
  _signingResolverHandle = resolver;
}

async function prepareAndExecute({ party, commands, commandId, readAs = [] }) {
  if (!_signingResolverHandle) {
    throw new Error(
      "SigningProvider resolver not initialized — call setSigningResolver() in main() before any prepareAndExecute() invocation.",
    );
  }

  const provider = await _signingResolverHandle.forParty(party);
  const result = await provider.prepareExecuteAndWait({
    commandId,
    commands,
    actAs: [party],
    readAs,
    synchronizerId: config.synchronizerId,
    disclosedContracts: [],
    packageIdSelectionPreference: [],
  });

  // Return shape kept compatible with prior body (`updateId` etc.).
  // PrepareExecuteAndWaitResult is `{ tx: { status, commandId, payload: { updateId, completionOffset } } }`.
  return {
    updateId: result.tx.payload.updateId,
    completionOffset: result.tx.payload.completionOffset,
    commandId: result.tx.commandId,
  };
}

function buildCreateArguments(startTime, endTime) {
  const vestingMode = buildVestingMode(startTime, endTime);
  return {
    config: {
      streamId: config.streamId,
      sender: config.senderParty,
      recipient: config.recipientParty,
      totalDeposited: config.amount,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      vestingMode,
      assetType: "GlobalHolding",
      instrumentRef: {
        depository: config.instrumentDepository,
        issuer: config.instrumentAdmin,
        instrumentId: config.instrumentId,
        instrumentVersion: config.instrumentVersion,
      },
      settlementMode: "TokenStandardCustody",
      cancellable: true,
    },
    depositAmount: config.amount,
    escrowOperator: config.escrowParty,
    fundingReference: config.fundingReference,
    senderAccountRef: config.senderAccountRef,
    recipientAccountRef: config.recipientAccountRef,
    observers: [],
  };
}

function buildVestingMode(startTime, endTime) {
  switch (normalizeVestingMode(config.vestingMode)) {
    case "Linear":
      return { tag: "Linear", value: {} };
    case "CliffLinear": {
      const cliffTime = config.cliffTime
        ? new Date(config.cliffTime)
        : new Date(startTime.getTime() + Math.floor((endTime.getTime() - startTime.getTime()) / 2));
      if (Number.isNaN(cliffTime.getTime())) {
        throw new Error(`Invalid CLIFF_TIME: ${config.cliffTime}`);
      }
      return {
        tag: "CliffLinear",
        value: {
          cliffTime: cliffTime.toISOString(),
        },
      };
    }
    case "Stepped":
      if (!Number.isFinite(config.stepIntervalMicros) || config.stepIntervalMicros <= 0) {
        throw new Error("STEP_INTERVAL_MICROS must be > 0 for stepped vesting");
      }
      if (!String(config.amountPerStep || "").trim()) {
        throw new Error("AMOUNT_PER_STEP is required for stepped vesting");
      }
      return {
        tag: "Stepped",
        value: {
          stepInterval: { microseconds: String(config.stepIntervalMicros) },
          amountPerStep: String(config.amountPerStep),
        },
      };
    case "RenewableTerm":
      if (!Number.isFinite(config.termDurationMicros) || config.termDurationMicros <= 0) {
        throw new Error("TERM_DURATION_MICROS must be > 0 for renewable vesting");
      }
      return {
        tag: "RenewableTerm",
        value: {
          termDuration: { microseconds: String(config.termDurationMicros) },
        },
      };
    default:
      throw new Error(`Unsupported vesting mode: ${config.vestingMode}`);
  }
}

function parseNumeric10(value) {
  const raw = String(value ?? "0").trim();
  if (!raw) return 0n;
  const negative = raw.startsWith("-");
  const normalized = negative ? raw.slice(1) : raw;
  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const whole = wholePart ? BigInt(wholePart) : 0n;
  const fractional = BigInt((fractionalPart + "0000000000").slice(0, 10));
  const units = whole * 10_000_000_000n + fractional;
  return negative ? -units : units;
}

function formatNumeric10(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / 10_000_000_000n;
  const fractional = String(absolute % 10_000_000_000n).padStart(10, "0");
  return `${negative ? "-" : ""}${whole}.${fractional}`;
}

function renderValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object" && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
}

function sumHoldingAmounts(events, owner) {
  return events
    .filter((entry) => entry.templateId.includes("Utility.Registry.Holding.V0.Holding:Holding"))
    .filter((entry) => String(entry.createArguments?.owner || "") === owner)
    .filter((entry) => String(entry.createArguments?.instrument?.id || "") === config.instrumentId)
    .filter((entry) => {
      const instrument = entry.createArguments?.instrument ?? {};
      const registrar =
        entry.createArguments?.registrar ??
        instrument.source ??
        instrument.admin ??
        instrument.issuer ??
        "";
      return String(registrar) === config.instrumentAdmin;
    })
    .reduce((total, entry) => total + parseNumeric10(entry.createArguments?.amount), 0n);
}

async function pollForCompletedStream(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await queryVisibleContracts([
      config.senderParty,
      config.recipientParty,
      config.escrowParty,
    ]);
    const stream = events.find(
      (entry) =>
        entry.templateId.includes("TokenStandardEscrow") &&
        entry.createArguments?.config?.streamId === config.streamId,
    );
    if (stream && String(stream.createArguments?.state?.status || "") === "Completed") {
      return stream;
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting for completed TokenStandardEscrow for ${config.streamId}`);
}

async function withdrawViaOrchestrator(serviceTransport, orchestrator, logger) {
  return orchestrator.withdraw(
    serviceTransport,
    config.senderParty,
    config.streamId,
    [config.escrowParty],
    logger,
  );
}

async function applyAssetRegistryOverride() {
  if (!assetKey) return;
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const registryPath = resolve(__dirname, "..", "config/asset-registry.json");
  if (!existsSync(registryPath)) {
    console.error(`--asset-key supplied but ${registryPath} not found`);
    process.exit(2);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const asset = registry.assets?.[assetKey];
  if (!asset) {
    console.error(`Asset "${assetKey}" not in registry. Available: ${Object.keys(registry.assets ?? {}).join(", ")}`);
    process.exit(2);
  }
  // V1 fields are gone from the asset registry.
  // This V1 probe is superseded by the V2-only equivalent that lands once
  // CC and USDCx publish V2 interfaces per CIP-0112 §5. Until then, this
  // probe is non-functional.
  console.error(
    `testnet-usdcx-stream-probe.mjs is superseded by the V2-only architecture. ` +
    `The original V1 + TokenStandardCustody flow is no longer supported by the library. ` +
    `Per CIP-0112 section 5, USDCx is expected to publish V2 interfaces; once it does, use the V2 probe.`,
  );
  process.exit(2);
  // Unreachable but kept for type-flow until the file is deleted in a later sweep.
  if (!asset.v1Capable) {
    process.exit(2);
  }
  if (!process.env.INSTRUMENT_ID && asset.instrumentRef?.instrumentId) {
    config.instrumentId = asset.instrumentRef.instrumentId;
  }
  if (!process.env.INSTRUMENT_VERSION && asset.instrumentRef?.instrumentVersion) {
    config.instrumentVersion = asset.instrumentRef.instrumentVersion;
  }
  if (!process.env.INSTRUMENT_ADMIN && asset.instrumentRef?.issuer) {
    config.instrumentAdmin = asset.instrumentRef.issuer;
  }
  if (!process.env.INSTRUMENT_DEPOSITORY && asset.instrumentRef?.depository) {
    config.instrumentDepository = asset.instrumentRef.depository;
  }
  log("Asset registry override", {
    assetKey,
    displayName: asset.displayName,
    instrumentId: config.instrumentId,
    instrumentAdmin: config.instrumentAdmin,
    instrumentDepository: config.instrumentDepository,
  });
}

async function main() {
  await applyAssetRegistryOverride();

  // ---------------------------------------------------------------------
  // Pre-flight (shared across all probes)
  // ---------------------------------------------------------------------
  const preflightReport = await runPreflight({
    apiUrl: config.apiUrl,
    ledgerToken: config.ledgerToken,
    packageId: config.packageId,
    parties: [config.senderParty, config.recipientParty, config.escrowParty].filter(Boolean),
    assetKey: assetKey ?? undefined,
    targetNetwork: cliArgs.target,
    dryRun: cliArgs.dryRun,
  });
  printPreflightReport(preflightReport);
  if (!preflightReport.ok) {
    console.error("Pre-flight failed. Fix errors above and retry.");
    process.exit(2);
  }
  if (cliArgs.dryRun) {
    console.error("--dry-run requested; exiting before any ledger writes.");
    process.exit(0);
  }

  required(config.apiUrl, "CANTON_JSON_API_URL");
  required(config.ledgerToken, "CANTON_LEDGER_TOKEN or LEDGER_TOKEN");
  required(config.commandUserId, "CANTON_USER_ID or COMMAND_USER_ID");
  required(config.synchronizerId, "SYNCHRONIZER_ID");
  required(config.cantonHost, "CANTON_HOST");
  required(config.packageId, "CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID");
  required(config.senderParty, "SENDER_PARTY");
  required(config.recipientParty, "RECIPIENT_PARTY");
  required(config.escrowParty, "ESCROW_PARTY");
  // Wallet Gateway connection is the only signing config required.
  required(
    env("CANTON_STREAMS_WALLET_GATEWAY_URL"),
    "CANTON_STREAMS_WALLET_GATEWAY_URL (signing now via gateway)",
  );
  required(
    env("CANTON_STREAMS_WALLET_GATEWAY_TOKEN"),
    "CANTON_STREAMS_WALLET_GATEWAY_TOKEN (signing now via gateway)",
  );
  required(config.instrumentAdmin, "INSTRUMENT_ADMIN");
  required(config.instrumentDepository, "INSTRUMENT_DEPOSITORY");

  const logger = createLogger("token-standard-probe", env("LOG_LEVEL", "info"));
  const orchestrator = createDefaultOrchestrator();

  // Bootstrap the SigningProvider resolver from env. The
  // resolver lazy-binds each party to its gateway-owned key on first
  // use; per-party caching keeps subsequent calls fast.
  const signingFactory = createSigningFromEnv();
  setSigningResolver(signingFactory.resolver);
  log("Signing", {
    gatewayUrl: env("CANTON_STREAMS_WALLET_GATEWAY_URL"),
    resolverKind: signingFactory.kind ?? "wallet-gateway",
  });

  const serviceTransport = new GrpcTransport({
    host: config.cantonHost,
    port: config.cantonPort,
    useTls: config.cantonUseTls,
    synchronizerId: config.synchronizerId,
    token: config.ledgerToken,
    actAs: [config.escrowParty],
    readAs: [],
  });

  try {
    const initialEvents = await queryVisibleContracts([config.recipientParty]);
    const initialRecipientAmount = sumHoldingAmounts(initialEvents, config.recipientParty);
    log("Recipient Baseline", {
      party: config.recipientParty,
      instrumentId: config.instrumentId,
      amount: formatNumeric10(initialRecipientAmount),
    });

    const startTime = new Date(Date.now() + config.streamStartDelaySeconds * 1000);
    const endTime = new Date(startTime.getTime() + config.streamDurationSeconds * 1000);
    const createTemplateId =
      `${config.packageId}:CantonStreams.Workflow.CreateTokenStandardStream:CreateTokenStandardStreamRequest`;

    const createResult = await prepareAndExecute({
      party: config.senderParty,
      commandId: `token-standard-create-${config.streamId}-${Date.now()}`,
      commands: [
        {
          CreateCommand: {
            templateId: createTemplateId,
            createArguments: buildCreateArguments(startTime, endTime),
          },
        },
      ],
    });
    log("Create Submitted", createResult);

    const requestContract = await waitForContract(
      (entry) =>
        entry.templateId.includes("CreateTokenStandardStreamRequest") &&
        entry.createArguments?.config?.streamId === config.streamId,
      [config.senderParty, config.recipientParty],
      "CreateTokenStandardStreamRequest",
    );

    const acceptResult = await prepareAndExecute({
      party: config.recipientParty,
      commandId: `token-standard-accept-${config.streamId}-${Date.now()}`,
      commands: [
        {
          ExerciseCommand: {
            templateId: requestContract.templateId,
            contractId: requestContract.contractId,
            choice: "AcceptTokenStandardRequest",
            choiceArgument: {},
          },
        },
      ],
    });
    log("Accept Submitted", acceptResult);

    const acceptedRequest = await waitForContract(
      (entry) =>
        entry.templateId.includes("AcceptedTokenStandardStreamRequest") &&
        entry.createArguments?.config?.streamId === config.streamId,
      [config.senderParty, config.recipientParty, config.escrowParty],
      "AcceptedTokenStandardStreamRequest",
    );

    const finalizeResult = await orchestrator.finalize(
      serviceTransport,
      config.senderParty,
      config.streamId,
      config.escrowParty,
      [config.escrowParty],
      logger,
      acceptedRequest.contractId,
    );
    log("Finalize Result", finalizeResult);

    const activeEscrow = await waitForContract(
      (entry) =>
        entry.templateId.includes("TokenStandardEscrow") &&
        entry.createArguments?.config?.streamId === config.streamId,
      [config.senderParty, config.recipientParty, config.escrowParty],
      "TokenStandardEscrow",
    );

    const intervalSeconds =
      config.withdrawIntervalSeconds > 0
        ? config.withdrawIntervalSeconds
        : Math.max(1, Math.floor(config.streamDurationSeconds / 2));
    const intervalCount = Math.max(1, Math.floor(config.streamDurationSeconds / intervalSeconds));
    const withdrawResults = [];

    for (let index = 1; index <= intervalCount; index += 1) {
      const targetTime =
        index < intervalCount
          ? startTime.getTime() + index * intervalSeconds * 1000
          : endTime.getTime() + 2_000;
      const waitMs = Math.max(0, targetTime - Date.now());
      if (waitMs > 0) {
        console.log(
          `[token-standard-probe] waiting ${waitMs}ms for withdraw ${index}/${intervalCount}`,
        );
        await sleep(waitMs);
      }

      const result = await withdrawViaOrchestrator(serviceTransport, orchestrator, logger);
      withdrawResults.push(result);
      log(`Withdraw ${index}/${intervalCount}`, result);
      if (String(result?.newStatus || "") === "Completed") {
        console.log(
          `[token-standard-probe] stream ${config.streamId} completed after withdraw ${index}/${intervalCount}`,
        );
        break;
      }
    }

    const waitForCompletionMs = Math.max(config.completionTimeoutMs, 30_000);
    const completedEscrow = await pollForCompletedStream(waitForCompletionMs);

    const finalEvents = await queryVisibleContracts([config.recipientParty]);
    const finalRecipientAmount = sumHoldingAmounts(finalEvents, config.recipientParty);
    const delta = finalRecipientAmount - initialRecipientAmount;

    const summary = {
      streamId: config.streamId,
      settlementMode: "TokenStandardCustody",
      instrumentId: config.instrumentId,
      vestingMode: normalizeVestingMode(config.vestingMode),
      createContractId: requestContract.contractId,
      acceptedRequestContractId: acceptedRequest.contractId,
      activeEscrowContractId: activeEscrow.contractId,
      completedEscrowContractId: completedEscrow.contractId,
      withdrawCount: withdrawResults.length,
      withdrawals: withdrawResults.map((result) => renderValue(result?.amountWithdrawn)),
      status: completedEscrow.createArguments?.state?.status ?? null,
      totalWithdrawn: completedEscrow.createArguments?.state?.totalWithdrawn ?? null,
      escrowAmount: completedEscrow.createArguments?.escrowAmount ?? null,
      recipientAmountBefore: formatNumeric10(initialRecipientAmount),
      recipientAmountAfter: formatNumeric10(finalRecipientAmount),
      recipientDelta: formatNumeric10(delta),
      transportHost: `${config.cantonHost}:${config.cantonPort}`,
    };

    log("Summary", summary);

    const expected = parseNumeric10(config.amount);
    if (delta !== expected) {
      throw new Error(
        `Recipient delta ${formatNumeric10(delta)} does not match expected ${formatNumeric10(expected)}`,
      );
    }
  } finally {
    await serviceTransport.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
