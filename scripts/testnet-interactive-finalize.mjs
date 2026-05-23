#!/usr/bin/env node

import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();

const config = {
  apiUrl: env("CANTON_JSON_API_URL").replace(/\/+$/, ""),
  token: env("CANTON_LEDGER_TOKEN"),
  userId: env("CANTON_USER_ID", "ledger-api-user"),
  synchronizerId: env("SYNCHRONIZER_ID"),
  escrowParty: env("ESCROW_PARTY"),
  escrowPrivateKey: env("ESCROW_PRIVATE_KEY"),
  contractId: env("ACCEPTED_REQUEST_CONTRACT_ID"),
  templateId: env(
    "ACCEPTED_REQUEST_TEMPLATE_ID",
    `${env("CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID")}:CantonStreams.Workflow.CreateTokenStandardStream:AcceptedTokenStandardStreamRequest`,
  ),
  settlementReference: env("SETTLEMENT_REFERENCE"),
  confirmedEscrowAmount: env("CONFIRMED_ESCROW_AMOUNT", env("DEPOSIT_AMOUNT")),
  commandId: env("COMMAND_ID", `streams-finalize-${Date.now()}`),
};

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function signPreparedHash(preparedTransactionHash, privateKeyBase64) {
  const naclSecret = Buffer.from(privateKeyBase64, "base64");
  if (naclSecret.length !== 64) {
    throw new Error(`ESCROW_PRIVATE_KEY must decode to 64 bytes, got ${naclSecret.length}`);
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
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Header, seed]),
    format: "der",
    type: "pkcs8",
  });

  return cryptoSign(null, Buffer.from(preparedTransactionHash, "base64"), privateKey).toString("base64");
}

async function request(path, body) {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
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
    const rendered = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} ${path}: ${rendered}`);
  }

  return payload;
}

async function main() {
  required(config.apiUrl, "CANTON_JSON_API_URL");
  required(config.token, "CANTON_LEDGER_TOKEN");
  required(config.escrowParty, "ESCROW_PARTY");
  required(config.escrowPrivateKey, "ESCROW_PRIVATE_KEY");
  required(config.contractId, "ACCEPTED_REQUEST_CONTRACT_ID");
  required(config.templateId, "ACCEPTED_REQUEST_TEMPLATE_ID or CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID");
  required(config.settlementReference, "SETTLEMENT_REFERENCE");
  required(config.confirmedEscrowAmount, "CONFIRMED_ESCROW_AMOUNT or DEPOSIT_AMOUNT");
  required(config.synchronizerId, "SYNCHRONIZER_ID");

  const commands = [
    {
      ExerciseCommand: {
        templateId: config.templateId,
        contractId: config.contractId,
        choice: "FinalizeTokenStandardEscrow",
        choiceArgument: {
          escrowReference: config.escrowParty,
          settlementReference: config.settlementReference,
          confirmedEscrowAmount: config.confirmedEscrowAmount,
        },
      },
    },
  ];

  const prepared = await request("/v2/interactive-submission/prepare", {
    userId: config.userId,
    commandId: config.commandId,
    commands,
    actAs: [config.escrowParty],
    readAs: [],
    synchronizerId: config.synchronizerId,
    disclosedContracts: [],
    verboseHashing: false,
    packageIdSelectionPreference: [],
  });

  const signature = signPreparedHash(prepared.preparedTransactionHash, config.escrowPrivateKey);
  const executed = await request("/v2/interactive-submission/executeAndWait", {
    userId: config.userId,
    preparedTransaction: prepared.preparedTransaction,
    hashingSchemeVersion: prepared.hashingSchemeVersion || "HASHING_SCHEME_VERSION_V2",
    submissionId: config.commandId,
    deduplicationPeriod:
      prepared.deduplicationPeriod && typeof prepared.deduplicationPeriod === "object"
        ? prepared.deduplicationPeriod
        : { Empty: {} },
    partySignatures: {
      signatures: [
        {
          party: config.escrowParty,
          signatures: [
            {
              signature,
              signedBy: config.escrowParty.split("::").slice(-1)[0],
              format: "SIGNATURE_FORMAT_CONCAT",
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
            },
          ],
        },
      ],
    },
  });

  console.log(
    JSON.stringify(
      {
        escrowParty: config.escrowParty,
        commandId: config.commandId,
        updateId: executed?.updateId ?? executed?.result?.updateId ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
