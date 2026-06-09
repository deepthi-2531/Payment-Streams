/**
 * @module signing/factory
 *
 * Config-driven entry point for setting up signing in a deployment.
 *
 * Most consumers want this rather than constructing adapters by hand:
 *
 * ```typescript
 * import { createSigningFromEnv } from '@canton-streams/sdk';
 *
 * const { resolver } = await createSigningFromEnv();
 * const provider = await resolver.forParty(escrowOperatorParty);
 * await provider.prepareExecuteAndWait({ commands, actAs: [escrowOperatorParty] });
 * ```
 *
 * Required env vars:
 *   - `CANTON_STREAMS_WALLET_GATEWAY_URL` — base URL of the gateway dApp API
 *     (e.g. `https://gateway.example/api/v0/dapp`)
 *   - `CANTON_STREAMS_WALLET_GATEWAY_TOKEN` — JWT issued by the gateway during
 *     `connect()`. For server-side automation, obtain this via the User API's
 *     `addSession()` + the gateway's IdP integration.
 *
 * Optional:
 *   - `CANTON_STREAMS_SIGNING_TIMEOUT_MS` — per-call timeout (default 30000)
 *   - `CANTON_STREAMS_SIGNING_EAGER` — set to `true` to pre-warm the
 *     listAccounts cache on init
 *   - `CANTON_STREAMS_SIGNING_LIST_ACCOUNTS_TTL_MS` — cache TTL (default
 *     300000 = 5 minutes)
 */

import {
  createSigningProviderResolver,
  type ResolverOptions,
} from './resolver.js';
import type {
  GatewayConnection,
  SigningProviderResolver,
} from './provider.js';

export interface FactoryResult {
  readonly resolver: SigningProviderResolver;
  readonly connection: GatewayConnection;
}

export interface FromEnvOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly resolver?: ResolverOptions;
}

/**
 * Construct a signing resolver from environment variables. Throws if
 * required vars are missing.
 */
export async function createSigningFromEnv(
  opts: FromEnvOptions = {},
): Promise<FactoryResult> {
  const env = opts.env ?? process.env;
  const gatewayUrl = required(env, 'CANTON_STREAMS_WALLET_GATEWAY_URL');
  const accessToken = required(env, 'CANTON_STREAMS_WALLET_GATEWAY_TOKEN');
  const timeoutMs = parsePositiveInt(env['CANTON_STREAMS_SIGNING_TIMEOUT_MS']);
  const eager = parseBoolean(env['CANTON_STREAMS_SIGNING_EAGER']);
  const listAccountsTtlMs = parsePositiveInt(
    env['CANTON_STREAMS_SIGNING_LIST_ACCOUNTS_TTL_MS'],
  );

  const connection: GatewayConnection = {
    gatewayUrl,
    accessToken,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  };

  const resolverOptions: ResolverOptions = {
    ...(eager !== undefined ? { eager } : {}),
    ...(listAccountsTtlMs !== undefined ? { listAccountsTtlMs } : {}),
    ...(opts.resolver ?? {}),
  };

  const resolver = await createSigningProviderResolver(connection, resolverOptions);
  return { resolver, connection };
}

/**
 * Construct a signing resolver from explicit config (no env reads).
 * Use for tests + custom deployments.
 */
export async function createSigning(
  connection: GatewayConnection,
  resolverOptions: ResolverOptions = {},
): Promise<FactoryResult> {
  const resolver = await createSigningProviderResolver(connection, resolverOptions);
  return { resolver, connection };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const v = env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}. See docs/integration-guide/README.md.`);
  }
  return v.trim();
}

function parsePositiveInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function parseBoolean(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}
