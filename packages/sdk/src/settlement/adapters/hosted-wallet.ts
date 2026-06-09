/**
 * @module settlement/adapters/hosted-wallet
 *
 * @deprecated Use the V2 AllocationRequest dispatcher and SigningProvider
 * wallet-gateway path instead.
 *
 * 1. **Settlement-reference path** replaced by V2 AllocationRequest
 *    pattern. Use `dispatchSettlement` from
 *    `settlement/allocation-dispatch.ts`.
 *
 * 2. **In-process signing** (`signPreparedHash` calling
 *    `node:crypto.sign` with a PEM key in memory) is unsafe for
 *    production. Signing keys should live in the Wallet Gateway's
 *    bound signing provider, never in the SDK or proxy process.
 *
 * For new code, use:
 *
 * ```typescript
 * import { createSigningFromEnv } from '@canton-streams/sdk';
 * const { resolver } = await createSigningFromEnv();
 * const provider = await resolver.forParty(actAsParty);
 * // The gateway routes signing internally to the bound provider;
 * // no PEM keys, no node:crypto, no in-process key material.
 * await provider.prepareExecuteAndWait({ commands, actAs: [actAsParty] });
 * ```
 *
 * This adapter remains only for backwards compatibility.
 */

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** @deprecated See module-level deprecation notice. */
export interface HostedWalletPartyCredentials {
  readonly appToken?: string;
  readonly publicKey?: string;
  readonly privateKey?: string;
  readonly privateKeyFile?: string;
}

export interface WalletGatewayExecuteResponse {
  readonly ok?: boolean;
  readonly commandId?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly externalSigning?: {
    readonly completionUpdateId?: string | null;
    readonly externalTransactionHash?: string | null;
  } | null;
  readonly _retryRequired?: boolean;
  readonly _retryAction?: string | null;
}

export function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : undefined;
}

export function signPreparedHash(
  preparedTransactionHash: string,
  credentials: Pick<HostedWalletPartyCredentials, 'privateKey' | 'privateKeyFile'>,
): string {
  const hashBytes = Buffer.from(preparedTransactionHash, 'base64');

  if (credentials.privateKeyFile) {
    const pem = readFileSync(credentials.privateKeyFile, 'utf8');
    return cryptoSign(null, hashBytes, createPrivateKey(pem)).toString('base64');
  }

  const privateKey = trimToUndefined(credentials.privateKey);
  if (!privateKey) {
    throw new Error('wallet-gateway credentials are missing a private key');
  }

  // Prefix match, not substring; PEM is always anchored at `-----BEGIN`.
  if (privateKey.startsWith('-----BEGIN')) {
    return cryptoSign(null, hashBytes, createPrivateKey(privateKey)).toString('base64');
  }

  const naclSecret = Buffer.from(privateKey, 'base64');
  if (naclSecret.length !== 64) {
    throw new Error(
      `wallet-gateway privateKey must decode to 64 bytes (NaCl seed+pub), got ${naclSecret.length}`,
    );
  }

  const seed = naclSecret.subarray(0, 32);
  const pkcs8Header = Buffer.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8Der = Buffer.concat([pkcs8Header, seed]);
  const signingKey = createPrivateKey({
    key: pkcs8Der,
    format: 'der',
    type: 'pkcs8',
  });
  return cryptoSign(null, hashBytes, signingKey).toString('base64');
}

export function extractSettlementReferenceFromWalletGatewayResult(
  result: WalletGatewayExecuteResponse | Record<string, unknown>,
): string {
  const resultRecord = maybeRecord(result);
  const candidates = [
    readNestedTextField(result, ['externalSigning', 'completionUpdateId']),
    readNestedTextField(result, ['externalSigning', 'externalTransactionHash']),
    readTextField(maybeRecord(resultRecord?.['result']), 'completionUpdateId'),
    readNestedTextField(result, ['result', 'completion', 'updateId']),
    readTextField(resultRecord, 'commandId'),
  ];

  for (const candidate of candidates) {
    const rendered = trimToUndefined(candidate);
    if (rendered) {
      return rendered;
    }
  }

  throw new Error(
    `wallet-gateway execute-action returned no settlement reference: ${JSON.stringify(result, null, 2)}`,
  );
}

export function readHostedWalletCredentialMapFromEnv(): Record<
  string,
  HostedWalletPartyCredentials
> {
  const credentials: Record<string, HostedWalletPartyCredentials> = {};

  const rawMapping = trimToUndefined(process.env['CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON']);
  if (rawMapping) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON: ${message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON must be a JSON object keyed by party ID.',
      );
    }

    for (const [party, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeCredentials(value);
      if (normalized) {
        credentials[party] = normalized;
      }
    }
  }

  injectLegacyCredentials(
    credentials,
    process.env['PROXY_ESCROW_OPERATOR'] ?? process.env['ESCROW_OPERATOR'],
    {
      appToken:
        process.env['PROXY_ESCROW_OPERATOR_APP_TOKEN'] ?? process.env['ESCROW_OPERATOR_APP_TOKEN'],
      publicKey:
        process.env['PROXY_ESCROW_OPERATOR_PUBLIC_KEY'] ??
        process.env['ESCROW_OPERATOR_PUBLIC_KEY'],
      privateKey:
        process.env['PROXY_ESCROW_OPERATOR_PRIVATE_KEY'] ??
        process.env['ESCROW_OPERATOR_PRIVATE_KEY'],
      privateKeyFile:
        process.env['PROXY_ESCROW_OPERATOR_PRIVATE_KEY_FILE'] ??
        process.env['ESCROW_OPERATOR_PRIVATE_KEY_FILE'],
    },
  );
  injectLegacyCredentials(credentials, process.env['SENDER_PARTY'], {
    appToken: process.env['SENDER_APP_TOKEN'],
    publicKey: process.env['SENDER_PUBLIC_KEY'],
    privateKey: process.env['SENDER_PRIVATE_KEY'],
    privateKeyFile: process.env['SENDER_PRIVATE_KEY_FILE'],
  });
  injectLegacyCredentials(credentials, process.env['RECIPIENT_PARTY'], {
    appToken: process.env['RECIPIENT_APP_TOKEN'],
    publicKey: process.env['RECIPIENT_PUBLIC_KEY'],
    privateKey: process.env['RECIPIENT_PRIVATE_KEY'],
    privateKeyFile: process.env['RECIPIENT_PRIVATE_KEY_FILE'],
  });

  return credentials;
}

function injectLegacyCredentials(
  target: Record<string, HostedWalletPartyCredentials>,
  party: string | undefined,
  value: Partial<HostedWalletPartyCredentials>,
): void {
  const partyId = trimToUndefined(party);
  if (!partyId || target[partyId]) {
    return;
  }
  const normalized = normalizeCredentials(value);
  if (normalized) {
    target[partyId] = normalized;
  }
}

function normalizeCredentials(value: unknown): HostedWalletPartyCredentials | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const appToken = trimToUndefined(asString(record['appToken']) ?? asString(record['token']));
  const publicKey = trimToUndefined(
    asString(record['publicKey']) ?? asString(record['public_key']),
  );
  const privateKey = trimToUndefined(
    asString(record['privateKey']) ?? asString(record['private_key']),
  );
  const privateKeyFile = trimToUndefined(
    asString(record['privateKeyFile']) ?? asString(record['private_key_file']),
  );

  if (!appToken && !publicKey && !privateKey && !privateKeyFile) {
    return undefined;
  }

  return {
    ...(appToken ? { appToken } : {}),
    ...(publicKey ? { publicKey } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(privateKeyFile ? { privateKeyFile } : {}),
  };
}

function readTextField(
  value: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const rendered = value?.[field];
  return typeof rendered === 'string' ? rendered : undefined;
}

function readNestedTextField(value: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = value;
  for (const step of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function maybeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
