/**
 * @module signing/provider
 *
 * Per-party signing provider for server-side automation.
 *
 * Replaces the legacy in-process signing path (`amulet.ts` +
 * `hosted-wallet.ts` with `signPreparedHash` calling `node:crypto`).
 * Per plan §0 and STR-84, signing keys live in the Wallet Gateway's
 * bound signing provider — never in our process.
 *
 * ## Wire contract (verified against upstream)
 *
 * The Splice Wallet Gateway exposes a JSON-RPC 2.0 dApp API at
 * `/api/v0/dapp`. The 5 documented signing providers
 * (Wallet Gateway Internal, Participant, Fireblocks, Blockdaemon, Dfns)
 * are bound **per-party at wallet creation time** via the User API;
 * the dApp side never picks the provider at call time. Instead, the
 * SDK calls `listAccounts()` to retrieve each `Wallet`'s
 * `signingProviderId` and routes per-party.
 *
 * Field names + shapes here mirror `@canton-network/core-wallet-dapp-rpc-client`
 * (verified May 2026 — see `docs/integration-guide/dapp-sdk-types-reference.md`).
 */

import type {
  PrepareExecuteParams,
  PrepareExecuteAndWaitResult,
  LedgerApiParams,
  LedgerApiResult,
  SignMessageParams,
  SignMessageResult,
  Wallet,
  ListAccountsResult,
} from './rpc-types.js';

// ---------------------------------------------------------------------------
// Signing provider kinds (verified upstream list)
// ---------------------------------------------------------------------------

/**
 * The 5 signing-provider kinds documented in the Splice Wallet Gateway
 * (`docs/dapp-building/wallet-gateway/signing-providers/index.md`).
 *
 * Selected per-party at wallet creation; the SDK reads each
 * `Wallet.signingProviderId` to identify which provider holds the key.
 */
export type SigningProviderKind =
  | 'wallet-gateway-internal' // dev/test only — keys in Gateway DB
  | 'participant'             // Canton participant node manages keys (production default)
  | 'fireblocks'              // HSM-backed; FIREBLOCKS_API_KEY + key files
  | 'blockdaemon'             // BLOCKDAEMON_API_URL + BLOCKDAEMON_API_KEY
  | 'dfns';                   // MPC; DFNS_ORG_ID + DFNS_BASE_URL + DFNS_CRED_ID + DFNS_PRIVATE_KEY + DFNS_AUTH_TOKEN

/** Pretty-print a kind for logs. */
export function describeKind(kind: SigningProviderKind): string {
  switch (kind) {
    case 'wallet-gateway-internal':
      return 'Wallet Gateway Internal (dev/test only)';
    case 'participant':
      return 'Canton Participant';
    case 'fireblocks':
      return 'Fireblocks (HSM)';
    case 'blockdaemon':
      return 'Blockdaemon';
    case 'dfns':
      return 'Dfns (MPC)';
  }
}

/** True iff the provider is production-grade (anything except the dev-only internal). */
export function isProductionProvider(kind: SigningProviderKind): boolean {
  return kind !== 'wallet-gateway-internal';
}

// ---------------------------------------------------------------------------
// Connection config
// ---------------------------------------------------------------------------

/**
 * Connection config for a Splice Wallet Gateway. The gateway is
 * deployment-wide (one URL per environment); per-party provider
 * routing happens INSIDE the gateway based on `Wallet.signingProviderId`.
 */
export interface GatewayConnection {
  /** Base URL of the gateway's dApp API. E.g. `https://gateway.example/api/v0/dapp`. */
  readonly gatewayUrl: string;
  /** JWT issued by the gateway during `connect()`. */
  readonly accessToken: string;
  /** Optional override fetch implementation (tests + non-node hosts). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Default request timeout in ms. Default 30_000. */
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// SigningProvider interface
// ---------------------------------------------------------------------------

/**
 * A SigningProvider is a thin wrapper around the Wallet Gateway's
 * JSON-RPC dApp API, tagged with the `kind` of the provider that
 * holds the signing key.
 *
 * For most call-sites, the appropriate object is obtained via
 * `SigningProviderResolver.forParty(party)` — that resolver looks up
 * which provider owns the party's key + returns the matching wrapper.
 *
 * All 5 provider kinds use the same wire protocol (JSON-RPC 2.0) and
 * the same set of methods; the differentiation is in:
 *   - The `kind` tag (for observability + logs)
 *   - Provider-specific error mapping at the JSON-RPC error.data layer
 *     (e.g. Dfns surfaces `dfns_*` codes; Fireblocks surfaces
 *     `fireblocks_*` codes — captured per-adapter as needed)
 */
export interface SigningProvider {
  /** Which signing provider holds the key. */
  readonly kind: SigningProviderKind;

  /** Gateway connection (URL + token). */
  readonly connection: GatewayConnection;

  /**
   * Submit a prepare-and-execute command (fire-and-forget).
   * Returns `null` per the verified spec; subscribe to `txChanged`
   * events for status.
   */
  prepareExecute(params: PrepareExecuteParams): Promise<null>;

  /**
   * Submit a prepare-and-execute command and wait for `executed`
   * status. Returns the executed event payload (`{ updateId, completionOffset }`).
   */
  prepareExecuteAndWait(params: PrepareExecuteParams): Promise<PrepareExecuteAndWaitResult>;

  /**
   * Sign an arbitrary message. Returns the signature.
   */
  signMessage(params: SignMessageParams): Promise<SignMessageResult>;

  /**
   * Proxy a Ledger API request through the gateway. The gateway
   * forwards to its configured ledger participant.
   */
  ledgerApi(params: LedgerApiParams): Promise<LedgerApiResult>;

  /**
   * List the wallets known to this gateway/session. Each `Wallet`
   * record includes `signingProviderId`, which determines which
   * adapter the resolver returns for that party.
   */
  listAccounts(): Promise<ListAccountsResult>;
}

// ---------------------------------------------------------------------------
// Per-party resolver
// ---------------------------------------------------------------------------

/**
 * Resolves a `SigningProvider` for a given party at call time.
 *
 * Most call-sites should hold a `SigningProviderResolver` rather than
 * a `SigningProvider` directly, because:
 *   - The gateway hosts multiple parties (sender, recipient, escrow
 *     operator), each potentially backed by a different signing provider
 *   - Per-party provider mapping is dynamic — admins can reassign a
 *     party to a different provider; the resolver should pick up the
 *     change after `invalidate()`
 *
 * Internal flow:
 *   1. `forParty(party)` first checks the cache
 *   2. On miss, calls `listAccounts()` on the underlying connection
 *   3. Looks up the `Wallet.signingProviderId` for the party
 *   4. Builds the matching `SigningProvider` adapter
 *   5. Caches the (party → provider) mapping
 *
 * Cache invalidation:
 *   - `invalidate()` — drop all entries
 *   - `invalidate(party)` — drop one entry
 *   - dapp-sdk's `accountsChanged` event SHOULD trigger
 *     `invalidate()` at the call-site (resolver is transport-agnostic
 *     so it doesn't subscribe directly)
 */
export interface SigningProviderResolver {
  /** Resolve the signing provider that owns this party's key. */
  forParty(party: string): Promise<SigningProvider>;

  /** Drop cached mappings (all parties or a specific one). */
  invalidate(party?: string): void;

  /**
   * The underlying gateway connection (read-only). Useful for
   * passing to non-signing helpers (e.g. ledgerApi reads that
   * don't need per-party resolution).
   */
  readonly connection: GatewayConnection;
}

// ---------------------------------------------------------------------------
// Error class (EIP-1474 codes per CIP-103)
// ---------------------------------------------------------------------------

/**
 * Standard EIP-1474 / CIP-103 error codes the gateway may return.
 * The transport maps JSON-RPC error responses to these codes; adapters
 * may add provider-specific codes via `data`.
 */
export const SigningErrorCode = {
  /** -32700 — Parse error. */
  PARSE_ERROR: -32700,
  /** -32600 — Invalid request. */
  INVALID_REQUEST: -32600,
  /** -32601 — Method not found. */
  METHOD_NOT_FOUND: -32601,
  /** -32602 — Invalid params. */
  INVALID_PARAMS: -32602,
  /** -32603 — Internal error. */
  INTERNAL_ERROR: -32603,
  /** 4001 — User rejected the request. */
  USER_REJECTED: 4001,
  /** 4100 — Unauthorized: missing/expired session, or party not authorized. */
  UNAUTHORIZED: 4100,
  /** 4900 — Disconnected from gateway. */
  DISCONNECTED: 4900,
  /** 4901 — Chain disconnected. */
  CHAIN_DISCONNECTED: 4901,
} as const;

export type SigningErrorCodeValue =
  (typeof SigningErrorCode)[keyof typeof SigningErrorCode];

/**
 * Error thrown by SigningProvider operations.
 */
export class SigningError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly kind?: SigningProviderKind | undefined;

  constructor(opts: {
    code: number;
    message: string;
    data?: unknown;
    kind?: SigningProviderKind | undefined;
  }) {
    super(opts.message);
    this.name = 'SigningError';
    this.code = opts.code;
    this.data = opts.data;
    this.kind = opts.kind;
  }
}

// Re-export verified RPC types so consumers don't need to know about
// the dapp-rpc-client package directly.
export type {
  PrepareExecuteParams,
  PrepareExecuteAndWaitResult,
  SignMessageParams,
  SignMessageResult,
  LedgerApiParams,
  LedgerApiResult,
  Wallet,
  ListAccountsResult,
};
