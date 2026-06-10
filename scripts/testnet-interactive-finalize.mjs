#!/usr/bin/env node
//
// Finalize an AcceptedTokenStandardStreamRequest as the escrow party.
//
// Signing model: the Wallet Gateway holds the escrow party's key and
// runs the prepare → sign → execute round-trip via the SDK
// SigningProvider. The old path (ESCROW_PRIVATE_KEY env var + in-process
// node:crypto signing against /v2/interactive-submission) is gone;
// this script never holds private key material.
//
// Required env vars:
//   CANTON_STREAMS_WALLET_GATEWAY_URL    Wallet Gateway dApp API base URL
//   CANTON_STREAMS_WALLET_GATEWAY_TOKEN  Wallet Gateway session token
//   SYNCHRONIZER_ID
//   ESCROW_PARTY
//   ACCEPTED_REQUEST_CONTRACT_ID
//   ACCEPTED_REQUEST_TEMPLATE_ID or CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID
//   SETTLEMENT_REFERENCE
//   CONFIRMED_ESCROW_AMOUNT or DEPOSIT_AMOUNT

import { createSigningFromEnv } from "../packages/sdk/dist/index.js";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();

const config = {
  synchronizerId: env("SYNCHRONIZER_ID"),
  escrowParty: env("ESCROW_PARTY"),
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

async function main() {
  required(env("CANTON_STREAMS_WALLET_GATEWAY_URL"), "CANTON_STREAMS_WALLET_GATEWAY_URL (signing via gateway)");
  required(env("CANTON_STREAMS_WALLET_GATEWAY_TOKEN"), "CANTON_STREAMS_WALLET_GATEWAY_TOKEN (signing via gateway)");
  required(config.escrowParty, "ESCROW_PARTY");
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

  // Gateway performs prepare → sign → execute for the escrow party.
  const { resolver } = await createSigningFromEnv();
  const provider = await resolver.forParty(config.escrowParty);
  const result = await provider.prepareExecuteAndWait({
    commandId: config.commandId,
    commands,
    actAs: [config.escrowParty],
    readAs: [],
    synchronizerId: config.synchronizerId,
    disclosedContracts: [],
    packageIdSelectionPreference: [],
  });

  console.log(
    JSON.stringify(
      {
        escrowParty: config.escrowParty,
        commandId: config.commandId,
        updateId: result?.tx?.payload?.updateId ?? null,
        completionOffset: result?.tx?.payload?.completionOffset ?? null,
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
