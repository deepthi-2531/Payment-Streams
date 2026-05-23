#!/usr/bin/env node

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { loadLocalScriptConfig } from "./local-config.mjs";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const localConfig = loadLocalScriptConfig("testnetHybridStreamProbe").values;

const configuredSynchronizerIdRaw = env("SYNCHRONIZER_ID", localConfig.synchronizerId ?? "");
const configuredSynchronizerId =
  /^(none|omit|auto)$/i.test(configuredSynchronizerIdRaw) ? "" : configuredSynchronizerIdRaw;

const config = {
  apiUrl: env("CANTON_JSON_API_URL", localConfig.cantonJsonApiUrl ?? "http://localhost:7575").replace(/\/$/, ""),
  token: env("CANTON_LEDGER_TOKEN"),
  userId: env("CANTON_USER_ID", "ledger-api-user"),
  synchronizerId: configuredSynchronizerId,
  walletGatewayUrl: env("WALLET_GATEWAY_URL").replace(/\/$/, ""),
  senderAppToken: env("SENDER_APP_TOKEN"),
  senderPublicKey: env("SENDER_PUBLIC_KEY"),
  serviceToken: env("SERVICE_LEDGER_TOKEN"),
  serviceUserId: env("SERVICE_USER_ID"),
  senderParty: env("SENDER_PARTY"),
  senderPrivateKey: env("SENDER_PRIVATE_KEY"),
  recipientParty: env("RECIPIENT_PARTY"),
  recipientPrivateKey: env("RECIPIENT_PRIVATE_KEY"),
  escrowOperator: env("ESCROW_OPERATOR"),
  registrarParty: env("REGISTRAR_PARTY"),
  holdingCid: env("HOLDING_CID"),
  amount: env("DEPOSIT_AMOUNT", "1.0"),
  rateAmount: env("RATE_AMOUNT"),
  rateIntervalSeconds: env("RATE_INTERVAL_SECONDS"),
  streamDurationSeconds: env("STREAM_DURATION_SECONDS"),
  streamStartDelaySeconds: env("STREAM_START_DELAY_SECONDS", "10"),
  instrumentId: env("INSTRUMENT_ID", "Amulet"),
  instrumentVersion: env("INSTRUMENT_VERSION", "testnet"),
  streamId: env("STREAM_ID", `cc-hybrid-${Date.now()}`),
};

const TOKEN_STANDARD_PACKAGE_ID = env(
  "CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID",
  localConfig.tokenStandardPackageId ?? "",
);

const STREAM_REQUEST_TEMPLATE_CANDIDATES = [
  `#${TOKEN_STANDARD_PACKAGE_ID}:CantonStreams.Workflow.CreateTokenStandardStream:CreateTokenStandardStreamRequest`,
  `${TOKEN_STANDARD_PACKAGE_ID}:CantonStreams.Workflow.CreateTokenStandardStream:CreateTokenStandardStreamRequest`,
];

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveNumber(rawValue, name) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got: ${rawValue}`);
  }
  return value;
}

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function fingerprintFromParty(party) {
  const pieces = String(party || "").split("::");
  return pieces[pieces.length - 1] || "";
}

function signPreparedHash(preparedTransactionHash, privateKeyBase64) {
  const naclSecret = Buffer.from(privateKeyBase64, "base64");
  if (naclSecret.length !== 64) {
    throw new Error(`privateKey must decode to 64 bytes, got ${naclSecret.length}`);
  }

  const seed = naclSecret.subarray(0, 32);
  const pkcs8Header = Buffer.from([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22,
    0x04, 0x20,
  ]);
  const pkcs8Der = Buffer.concat([pkcs8Header, seed]);
  const privateKey = createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });

  const hashBytes = Buffer.from(preparedTransactionHash, "base64");
  return cryptoSign(null, hashBytes, privateKey).toString("base64");
}

async function request(path, { method = "POST", body, token = config.token } = {}) {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    const rendered =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} ${path}: ${rendered}`);
  }

  return payload;
}

async function requestWalletGateway(path, body, token = config.senderAppToken) {
  if (!config.walletGatewayUrl) {
    throw new Error("WALLET_GATEWAY_URL is required for wallet-gateway requests");
  }
  if (!token) {
    throw new Error("SENDER_APP_TOKEN is required for wallet-gateway requests");
  }

  const response = await fetch(`${config.walletGatewayUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const rendered =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} wallet-gateway ${path}: ${rendered}`);
  }

  return payload;
}

async function getLedgerEnd() {
  const payload = await request("/v2/state/ledger-end", { method: "GET" });
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

  const payload = await request("/v2/state/active-contracts", {
    body: {
      userId: config.userId,
      activeAtOffset: offset,
      filter: { filtersByParty },
    },
  });

  return extractCreatedEvents(payload);
}

async function waitForContract(matchFn, parties, label, attempts = 15, delayMs = 1500) {
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
    console.log(
      `[probe] waiting for ${label} (attempt ${attempt}/${attempts})`,
    );
    await sleep(delayMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function prepareAndExecute({
  party,
  privateKeyBase64,
  commands,
  commandId,
  readAs = [],
}) {
  const preparePayload = {
    userId: config.userId,
    commandId,
    commands,
    actAs: [party],
    readAs,
    synchronizerId: config.synchronizerId,
    disclosedContracts: [],
    verboseHashing: false,
    packageIdSelectionPreference: [],
  };

  const prepared = await request("/v2/interactive-submission/prepare", {
    body: preparePayload,
  });

  const preparedTransactionHash = String(prepared?.preparedTransactionHash || "").trim();
  const preparedTransaction = String(prepared?.preparedTransaction || "").trim();
  if (!preparedTransactionHash || !preparedTransaction) {
    throw new Error(
      `Interactive prepare response missing hash/transaction: ${JSON.stringify(prepared, null, 2)}`,
    );
  }

  const signature = signPreparedHash(preparedTransactionHash, privateKeyBase64);
  const executePayload = {
    userId: config.userId,
    preparedTransaction,
    hashingSchemeVersion:
      String(prepared?.hashingSchemeVersion || "").trim() || "HASHING_SCHEME_VERSION_V2",
    submissionId: commandId,
    deduplicationPeriod:
      prepared?.deduplicationPeriod && typeof prepared.deduplicationPeriod === "object"
        ? prepared.deduplicationPeriod
        : { Empty: {} },
    partySignatures: {
      signatures: [
        {
          party,
          signatures: [
            {
              signature,
              signedBy: fingerprintFromParty(party),
              format: "SIGNATURE_FORMAT_CONCAT",
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
            },
          ],
        },
      ],
    },
  };

  try {
    const executed = await request("/v2/interactive-submission/executeAndWait", {
      body: executePayload,
    });
    return { prepared, executed, mode: "executeAndWait" };
  } catch (error) {
    const message = String(error?.message || error).toLowerCase();
    const isFallback =
      message.includes("404") ||
      message.includes("405") ||
      message.includes("method not allowed") ||
      message.includes("unsupported endpoint") ||
      message.includes("not found");
    if (!isFallback) {
      throw error;
    }

    const executed = await request("/v2/interactive-submission/execute", {
      body: executePayload,
    });
    return { prepared, executed, mode: "execute" };
  }
}

async function transferCcToEscrow(streamId) {
  required(config.walletGatewayUrl, "WALLET_GATEWAY_URL");
  required(config.senderAppToken, "SENDER_APP_TOKEN");
  required(config.senderPublicKey, "SENDER_PUBLIC_KEY");

  const prepare = await requestWalletGateway("/api/wallet-gateway/prepare-action", {
    action: "transfer_cc",
    party: config.senderParty,
    requestId: `streams-fund-${streamId}`,
    payload: {
      toParty: config.escrowOperator,
      amount: config.amount,
      memo: `streams-fund-${streamId}`,
    },
  });

  const preparedHash = String(prepare?.prepared?.preparedTransactionHash || "").trim();
  if (!preparedHash) {
    throw new Error(`Wallet-gateway prepare missing preparedTransactionHash: ${JSON.stringify(prepare)}`);
  }

  const signature = signPreparedHash(preparedHash, config.senderPrivateKey);
  const executed = await requestWalletGateway("/api/wallet-gateway/execute-action", {
    party: config.senderParty,
    sessionId: prepare.sessionId,
    publicKey: config.senderPublicKey,
    signature,
  });

  return {
    prepare,
    executed,
  };
}

function extractSettlementReference(executedTransfer) {
  const candidates = [
    executedTransfer?.externalSigning?.completionUpdateId,
    executedTransfer?.externalSigning?.externalTransactionHash,
    executedTransfer?.result?.completionUpdateId,
    executedTransfer?.result?.completion?.updateId,
    executedTransfer?.commandId,
  ];

  for (const candidate of candidates) {
    const rendered = String(candidate || "").trim();
    if (rendered) {
      return rendered;
    }
  }

  throw new Error(
    `Unable to determine settlement reference from wallet-gateway execute result: ${JSON.stringify(executedTransfer, null, 2)}`,
  );
}

async function submitAndWait(commands, { actAs, token, userId, commandId }) {
  return request("/v2/commands/submit-and-wait", {
    body: {
      commands,
      actAs,
      commandId,
      userId,
      synchronizerId: config.synchronizerId,
      packageIdSelectionPreference: [],
    },
    token,
  });
}

async function finalizeAcceptedRequest(acceptedRequest, settlementReference) {
  required(config.serviceToken, "SERVICE_LEDGER_TOKEN");
  required(config.serviceUserId, "SERVICE_USER_ID");

  const finalizeCommand = {
    ExerciseCommand: {
      templateId: acceptedRequest.templateId,
      contractId: acceptedRequest.contractId,
      choice: "FinalizeTokenStandardEscrow",
      choiceArgument: {
        escrowReference: config.escrowOperator,
        settlementReference,
        confirmedEscrowAmount: config.amount,
      },
    },
  };

  return submitAndWait(
    [finalizeCommand],
    {
      actAs: [config.escrowOperator],
      token: config.serviceToken,
      userId: config.serviceUserId,
      commandId: `streams-finalize-${config.streamId}-${Date.now()}`,
    },
  );
}

function buildCreateArgumentCandidates(startTime, endTime) {
  const baseConfig = {
    streamId: config.streamId,
    sender: config.senderParty,
    recipient: config.recipientParty,
    totalDeposited: config.amount,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    cancellable: true,
  };

  const instrumentRef = {
    depository: config.registrarParty,
    issuer: config.registrarParty,
    instrumentId: config.instrumentId,
    instrumentVersion: config.instrumentVersion,
  };

  const common = {
    depositAmount: config.amount,
    escrowOperator: config.escrowOperator,
    fundingReference: config.holdingCid,
    senderAccountRef: JSON.stringify({
      party: config.senderParty,
      wallet: "amm-testnet",
    }),
    recipientAccountRef: JSON.stringify({
      party: config.recipientParty,
      wallet: "amm-testnet",
    }),
    observers: [],
  };

  return [
    {
      label: "bare-optionals",
      createArguments: {
        config: {
          ...baseConfig,
          vestingMode: { tag: "Linear", value: {} },
          assetType: "GlobalHolding",
          instrumentRef,
          settlementMode: "TokenStandardCustody",
        },
        ...common,
      },
    },
    {
      label: "some-variants",
      createArguments: {
        config: {
          ...baseConfig,
          vestingMode: { tag: "Linear", value: {} },
          assetType: "GlobalHolding",
          instrumentRef: { tag: "Some", value: instrumentRef },
          settlementMode: { tag: "Some", value: "TokenStandardCustody" },
        },
        ...common,
      },
    },
    {
      label: "string-linear",
      createArguments: {
        config: {
          ...baseConfig,
          vestingMode: "Linear",
          assetType: "GlobalHolding",
          instrumentRef,
          settlementMode: "TokenStandardCustody",
        },
        ...common,
      },
    },
  ];
}

function resolveStreamTiming() {
  const startDelaySeconds = parsePositiveNumber(config.streamStartDelaySeconds, "STREAM_START_DELAY_SECONDS");
  const depositAmount = parsePositiveNumber(config.amount, "DEPOSIT_AMOUNT");

  let durationSeconds;
  if (config.streamDurationSeconds) {
    durationSeconds = parsePositiveNumber(config.streamDurationSeconds, "STREAM_DURATION_SECONDS");
  } else if (config.rateAmount || config.rateIntervalSeconds) {
    const rateAmount = parsePositiveNumber(config.rateAmount, "RATE_AMOUNT");
    const rateIntervalSeconds = parsePositiveNumber(
      config.rateIntervalSeconds,
      "RATE_INTERVAL_SECONDS",
    );
    durationSeconds = (depositAmount / rateAmount) * rateIntervalSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(
        `Computed stream duration is invalid for DEPOSIT_AMOUNT=${config.amount}, RATE_AMOUNT=${config.rateAmount}, RATE_INTERVAL_SECONDS=${config.rateIntervalSeconds}`,
      );
    }
  } else {
    durationSeconds = 100;
  }

  const startTime = new Date(Date.now() + Math.round(startDelaySeconds * 1000));
  const endTime = new Date(startTime.getTime() + Math.round(durationSeconds * 1000));

  return {
    startTime,
    endTime,
    startDelaySeconds,
    durationSeconds,
    depositAmount,
    rateAmount: config.rateAmount ? parsePositiveNumber(config.rateAmount, "RATE_AMOUNT") : null,
    rateIntervalSeconds: config.rateIntervalSeconds
      ? parsePositiveNumber(config.rateIntervalSeconds, "RATE_INTERVAL_SECONDS")
      : null,
  };
}

async function createStreamInteractively() {
  const timing = resolveStreamTiming();
  const { startTime, endTime } = timing;
  const commandIdBase = `streams-create-${Date.now()}`;
  const argumentCandidates = buildCreateArgumentCandidates(startTime, endTime);
  const failures = [];

  for (const templateId of STREAM_REQUEST_TEMPLATE_CANDIDATES) {
    for (const candidate of argumentCandidates) {
      const commandId = `${commandIdBase}-${candidate.label}`;
      const commands = [
        {
          CreateCommand: {
            templateId,
            createArguments: candidate.createArguments,
          },
        },
      ];

      try {
        log("Create Attempt", {
          templateId,
          encoding: candidate.label,
          streamId: config.streamId,
          amount: config.amount,
          rateAmount: timing.rateAmount,
          rateIntervalSeconds: timing.rateIntervalSeconds,
          durationSeconds: timing.durationSeconds,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        });

        const result = await prepareAndExecute({
          party: config.senderParty,
          privateKeyBase64: config.senderPrivateKey,
          commands,
          commandId,
        });

        log("Create Interactive Result", result);
        return { result, startTime, endTime };
      } catch (error) {
        const message = String(error?.message || error);
        failures.push({ templateId, encoding: candidate.label, message });
        console.log(`[probe] create failed for ${templateId} / ${candidate.label}: ${message}`);
      }
    }
  }

  throw new Error(`All interactive create attempts failed:\n${JSON.stringify(failures, null, 2)}`);
}

async function main() {
  required(TOKEN_STANDARD_PACKAGE_ID, "CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID");
  required(config.token, "CANTON_LEDGER_TOKEN");
  required(config.senderParty, "SENDER_PARTY");
  required(config.senderPrivateKey, "SENDER_PRIVATE_KEY");
  required(config.recipientParty, "RECIPIENT_PARTY");
  required(config.recipientPrivateKey, "RECIPIENT_PRIVATE_KEY");
  required(config.escrowOperator, "ESCROW_OPERATOR");
  required(config.registrarParty, "REGISTRAR_PARTY");
  required(config.holdingCid, "HOLDING_CID");

  log("Probe Config", {
    apiUrl: config.apiUrl,
    userId: config.userId,
    streamId: config.streamId,
    senderParty: config.senderParty,
    recipientParty: config.recipientParty,
    escrowOperator: config.escrowOperator,
    registrarParty: config.registrarParty,
    holdingCid: config.holdingCid,
    amount: config.amount,
    rateAmount: config.rateAmount || null,
    rateIntervalSeconds: config.rateIntervalSeconds || null,
    streamDurationSeconds: config.streamDurationSeconds || null,
    streamStartDelaySeconds: config.streamStartDelaySeconds,
    synchronizerId: config.synchronizerId,
    walletGatewayUrl: config.walletGatewayUrl || null,
    fundingAndFinalizeEnabled: Boolean(
      config.walletGatewayUrl &&
      config.senderAppToken &&
      config.senderPublicKey &&
      config.serviceToken &&
      config.serviceUserId,
    ),
  });

  await createStreamInteractively();

  const requestContract = await waitForContract(
    (entry) =>
      entry.templateId.includes("CreateTokenStandardStreamRequest") &&
      entry.createArguments?.config?.sender === config.senderParty &&
      entry.createArguments?.config?.streamId === config.streamId,
    [config.senderParty, config.recipientParty, config.escrowOperator],
    "CreateTokenStandardStreamRequest",
  );

  const acceptCommandId = `streams-accept-${Date.now()}`;
  const acceptResult = await prepareAndExecute({
    party: config.recipientParty,
    privateKeyBase64: config.recipientPrivateKey,
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
    commandId: acceptCommandId,
  });
  log("Accept Interactive Result", acceptResult);

  const acceptedRequest = await waitForContract(
    (entry) =>
      entry.templateId.includes("AcceptedTokenStandardStreamRequest") &&
      entry.createArguments?.config?.sender === config.senderParty &&
      entry.createArguments?.config?.streamId === config.streamId,
    [config.senderParty, config.recipientParty, config.escrowOperator],
    "AcceptedTokenStandardStreamRequest",
  );

  const fundingAndFinalizeEnabled =
    config.walletGatewayUrl &&
    config.senderAppToken &&
    config.senderPublicKey &&
    config.serviceToken &&
    config.serviceUserId;

  if (!fundingAndFinalizeEnabled) {
    log("Finalize Skipped", {
      reason:
        "Provide WALLET_GATEWAY_URL, SENDER_APP_TOKEN, SENDER_PUBLIC_KEY, SERVICE_LEDGER_TOKEN, and SERVICE_USER_ID to run the real Amulet funding + finalize steps.",
    });
    return;
  }

  const fundedTransfer = await transferCcToEscrow(config.streamId);
  log("Wallet-Gateway Funding Result", fundedTransfer);

  const settlementReference = extractSettlementReference(fundedTransfer.executed);
  log("Derived Settlement Reference", { settlementReference });

  const finalizeResult = await finalizeAcceptedRequest(acceptedRequest, settlementReference);
  log("Finalize Result", finalizeResult);

  await waitForContract(
    (entry) =>
      entry.templateId.includes("TokenStandardEscrow") &&
      entry.createArguments?.config?.sender === config.senderParty &&
      entry.createArguments?.config?.streamId === config.streamId,
    [config.senderParty, config.recipientParty, config.escrowOperator],
    "TokenStandardEscrow",
  );
}

main().catch((error) => {
  console.error("\n=== ERROR ===");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
