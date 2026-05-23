/**
 * @module signing/resolver
 *
 * Per-party `SigningProvider` resolver.
 *
 * The Splice Wallet Gateway hosts multiple parties (sender, recipient,
 * escrow operator, etc.), each potentially backed by a DIFFERENT
 * signing provider (verified upstream: provider chosen per-party at
 * `createWallet` time; one gateway can host parties using Participant
 * + Fireblocks + Dfns side by side).
 *
 * This resolver caches `(party → SigningProvider)` lookups and
 * supports invalidation on `accountsChanged` events from the dapp-sdk
 * (caller responsibility — the resolver is event-source-agnostic so
 * server-side automation can use it without a browser event loop).
 */

import type {
  GatewayConnection,
  SigningProvider,
  SigningProviderResolver,
  SigningProviderKind,
} from './provider.js';
import { SigningError, SigningErrorCode } from './provider.js';
import { JsonRpcTransport } from './transport.js';
import type { Wallet } from './rpc-types.js';
import { ParticipantSigningProvider } from './adapters/participant.js';
import { FireblocksSigningProvider } from './adapters/fireblocks.js';
import { BlockdaemonSigningProvider } from './adapters/blockdaemon.js';
import { DfnsSigningProvider } from './adapters/dfns.js';
import { WalletGatewayInternalSigningProvider } from './adapters/internal-gateway.js';

/**
 * Construct a SigningProvider of the given kind. Used by the resolver
 * + factory. Throws if the kind is unrecognized (defends against the
 * gateway returning a `signingProviderId` we don't know how to handle).
 */
export function makeAdapterForKind(
  kind: SigningProviderKind,
  connection: GatewayConnection,
): SigningProvider {
  switch (kind) {
    case 'participant':
      return new ParticipantSigningProvider(connection);
    case 'fireblocks':
      return new FireblocksSigningProvider(connection);
    case 'blockdaemon':
      return new BlockdaemonSigningProvider(connection);
    case 'dfns':
      return new DfnsSigningProvider(connection);
    case 'wallet-gateway-internal':
      return new WalletGatewayInternalSigningProvider(connection);
    default: {
      const _exhaust: never = kind;
      throw new SigningError({
        code: SigningErrorCode.INTERNAL_ERROR,
        message: `Unknown SigningProviderKind: ${_exhaust as string}`,
      });
    }
  }
}

/**
 * Map a gateway-reported `signingProviderId` string to our typed
 * `SigningProviderKind`. The gateway can theoretically return any
 * string; we recognize the 5 documented kinds and reject others.
 */
export function normalizeSigningProviderId(
  raw: string,
): SigningProviderKind | undefined {
  const kinds: SigningProviderKind[] = [
    'participant',
    'fireblocks',
    'blockdaemon',
    'dfns',
    'wallet-gateway-internal',
  ];
  const found = kinds.find((k) => k === raw);
  return found;
}

// ---------------------------------------------------------------------------
// Resolver implementation
// ---------------------------------------------------------------------------

export interface ResolverOptions {
  /**
   * Optional eager pre-load: at construction, fetch `listAccounts()`
   * and warm the cache. Useful for production startup so the first
   * `forParty` call doesn't surface a slow path. Default false.
   */
  readonly eager?: boolean;

  /**
   * Optional listAccounts cache TTL (ms). After this many ms the
   * resolver re-fetches accounts on the next `forParty` call,
   * regardless of whether the cached entry exists. Default
   * 5 * 60_000 (5 minutes). Set to 0 to disable.
   */
  readonly listAccountsTtlMs?: number;
}

const DEFAULT_LIST_ACCOUNTS_TTL_MS = 5 * 60 * 1000;

class SigningProviderResolverImpl implements SigningProviderResolver {
  readonly connection: GatewayConnection;
  private readonly transport: JsonRpcTransport;
  private readonly options: Required<ResolverOptions>;

  /**
   * Cached party → kind mapping. The actual SigningProvider object
   * is rebuilt on each `forParty` call from the cached kind; cheap
   * to do and avoids state-sharing between adapters.
   */
  private readonly kindCache = new Map<string, SigningProviderKind>();

  /** Timestamp of the last `listAccounts()` fetch. */
  private lastFetchAt = 0;

  constructor(connection: GatewayConnection, options: ResolverOptions = {}) {
    this.connection = connection;
    this.transport = new JsonRpcTransport(connection);
    this.options = {
      eager: options.eager ?? false,
      listAccountsTtlMs: options.listAccountsTtlMs ?? DEFAULT_LIST_ACCOUNTS_TTL_MS,
    };
  }

  /**
   * Eagerly populate the cache. Called once on `init()` from the
   * factory when `options.eager === true`.
   */
  async init(): Promise<void> {
    if (this.options.eager) {
      await this.refreshCache();
    }
  }

  async forParty(party: string): Promise<SigningProvider> {
    const cached = this.kindCache.get(party);
    const ttlExpired =
      this.options.listAccountsTtlMs > 0 &&
      Date.now() - this.lastFetchAt > this.options.listAccountsTtlMs;

    if (cached && !ttlExpired) {
      return makeAdapterForKind(cached, this.connection);
    }

    await this.refreshCache();
    const resolved = this.kindCache.get(party);
    if (!resolved) {
      throw new SigningError({
        code: SigningErrorCode.UNAUTHORIZED,
        message:
          `No wallet found for party ${party} on gateway ${this.connection.gatewayUrl}. ` +
          `Verify the party is allocated + the gateway session has visibility.`,
      });
    }
    return makeAdapterForKind(resolved, this.connection);
  }

  invalidate(party?: string): void {
    if (party === undefined) {
      this.kindCache.clear();
      this.lastFetchAt = 0;
      return;
    }
    this.kindCache.delete(party);
  }

  private async refreshCache(): Promise<void> {
    const accounts = await this.transport.request<Wallet[]>('listAccounts');
    this.kindCache.clear();
    for (const wallet of accounts) {
      const kind = normalizeSigningProviderId(wallet.signingProviderId);
      if (!kind) {
         
        console.warn(
          '[canton-streams] Unknown signingProviderId',
          wallet.signingProviderId,
          'for party',
          wallet.partyId,
          '— skipping. Add support in `normalizeSigningProviderId` if this is a new provider.',
        );
        continue;
      }
      this.kindCache.set(wallet.partyId, kind);
    }
    this.lastFetchAt = Date.now();
  }
}

/**
 * Create a per-party SigningProviderResolver against the given gateway.
 *
 * Use this for all server-side automation (treasury crons, auto-withdraw
 * worker, scheduled emissions). Each consumer should hold ONE resolver;
 * resolvers are designed to be long-lived + concurrency-safe.
 */
export async function createSigningProviderResolver(
  connection: GatewayConnection,
  options: ResolverOptions = {},
): Promise<SigningProviderResolver> {
  const resolver = new SigningProviderResolverImpl(connection, options);
  await resolver.init();
  return resolver;
}
