#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();

function readEnvValueFromFile(filePath, key) {
  const path = String(filePath || "").trim();
  if (!path) {
    return "";
  }
  try {
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    const prefix = `${key}=`;
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        return line.slice(prefix.length).trim();
      }
    }
  } catch {
    return "";
  }
  return "";
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signHs256(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64urlJson(header);
  const encodedPayload = base64urlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
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

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

const config = {
  appUrl: env("APP_URL", "http://127.0.0.1:3300").replace(/\/$/, ""),
  authSecret:
    env("AMM_AUTH_JWT_SECRET") ||
    readEnvValueFromFile(env("AUTH_SECRET_FILE", env("OPS_ENV_FILE", "/etc/bitdynamics/ops.env")), "AMM_AUTH_JWT_SECRET"),
  subject: env("APP_SUBJECT", "Streams Sender"),
  party: env("APP_PARTY"),
  role: env("APP_ROLE", "user"),
  audience: env("AMM_AUTH_CODE_AUDIENCE", "bitdynamics-app"),
  issuer: env("AMM_AUTH_CODE_ISSUER", "bitdynamics"),
  ttlSeconds: Number(env("APP_TOKEN_TTL_SECONDS", "3600")),
  toParty: env("TO_PARTY"),
  symbol: env("SYMBOL", "USDCx"),
  instrumentId: env("INSTRUMENT_ID", "USDCx"),
  instrumentAdmin: env("INSTRUMENT_ADMIN"),
  amount: env("AMOUNT", "1.0"),
  memo: env("MEMO", "streams-usdcx-escrow-test"),
  totalTimeoutMs: Number(env("WALLET_TRANSFER_TOTAL_TIMEOUT_MS", "120000")),
  cip56MaxAttempts: Number(env("CIP56_MAX_ATTEMPTS", "2")),
  cip56MaxCommandAttempts: Number(env("CIP56_MAX_COMMAND_ATTEMPTS", "2")),
  cip56SubmitTimeoutMs: Number(env("CIP56_SUBMIT_TIMEOUT_MS", "45000")),
};

if (!config.authSecret) {
  throw new Error("AMM_AUTH_JWT_SECRET is required");
}
if (!config.party) {
  throw new Error("APP_PARTY is required");
}
if (!config.toParty) {
  throw new Error("TO_PARTY is required");
}
if (!config.instrumentAdmin) {
  throw new Error("INSTRUMENT_ADMIN is required");
}

const now = Math.floor(Date.now() / 1000);
const token = signHs256(
  {
    sub: config.subject,
    party: config.party,
    roles: [config.role],
    iss: config.issuer,
    aud: config.audience,
    iat: now,
    exp: now + Math.max(60, config.ttlSeconds || 3600),
    jti: `streams-wallet-transfer-${now}`,
  },
  config.authSecret,
);

const body = {
  toParty: config.toParty,
  symbol: config.symbol,
  instrumentId: config.instrumentId,
  instrumentAdmin: config.instrumentAdmin,
  amount: config.amount,
  memo: config.memo,
  walletTransferTotalTimeoutMs: config.totalTimeoutMs,
  cip56FallbackEnabled: true,
  cip56MaxAttempts: config.cip56MaxAttempts,
  cip56MaxCommandAttempts: config.cip56MaxCommandAttempts,
  cip56SubmitTimeoutMs: config.cip56SubmitTimeoutMs,
};

const result = await postJson(`${config.appUrl}/api/wallet/transfer`, body, token);
console.log(JSON.stringify({ ok: result.ok, status: result.status, body: result.payload }, null, 2));
