/**
 * @module lib/walletHoldings
 *
 * Wallet-neutral facade for the dashboard's holdings reads.
 *
 * Different wallets expose holdings through different APIs (the
 * CIP-0103 spec deliberately doesn't standardize a "give me my
 * holdings" method). This module surfaces a single
 * `getWalletHoldings()` to the dashboard and dispatches under the
 * hood to the right per-wallet implementation based on which
 * adapter is currently active in PartyLayer.
 *
 * Today the implementations cover three real strategies:
 *
 *   1. `loop` — calls 5N Loop's REST API directly
 *      (`GET /api/v1/.connect/pair/account/holding`). Each holding
 *      returns symbol + issuer + instrument_id (admin, id) + locked
 *      / unlocked balances + decimals. Verified live on devnet.
 *
 *   2. `canonical-acs` — used for wallets whose CIP-0103 `ledgerApi`
 *      accepts a canonical Canton v2 ACS query without a wallet-side
 *      allowlist (Send, Nightly, Console). The dashboard queries
 *      the CIP-56 `HoldingV2` interface, decodes view payloads, and
 *      surfaces them in the same `WalletHolding` shape as Loop.
 *      This requires the Splice token-standard DARs to be vetted
 *      on the participant the wallet talks to.
 *
 *   3. `unsupported` — Cantor8 (signing-only adapter, no read API)
 *      and Bron (OAuth-only, no browser-side read API). The
 *      facade returns an empty list AND a discriminated `reason`
 *      so the UI can show a useful hint ("This wallet cannot list
 *      its holdings; pick another wallet to browse balances.").
 *
 * Adding a new wallet adapter:
 *   1. Identify the wallet's holdings access pattern
 *      (own REST, generic ledgerApi, browser-extension-injected).
 *   2. Add a case to `pickStrategy` keyed on the walletId from
 *      `walletClient.status().provider.id`.
 *   3. Either implement a new strategy in
 *      `lib/walletAdapters/<wallet>.ts` or reuse `canonical-acs`
 *      if the wallet exposes a stock CIP-0103 ledgerApi.
 */

import { walletClient } from '../store/wallet/index.js';
import {
  getLoopHoldings,
  isLoopWalletActive,
  type LoopHolding,
} from './loopWallet.js';
import {
  queryHoldingsViaLedgerApi,
  type AcsHolding,
} from './walletAdapters/canonicalAcs.js';

/**
 * Wallet-neutral holding shape. Subset of fields every wallet can
 * reasonably produce; per-wallet metadata that's not portable
 * (e.g. Loop's utxoCount, logo image path) lives on
 * `extension.<walletId>`.
 */
export interface WalletHolding {
  /** Canonical CIP-56 (admin, id) pair — maps onto our InstrumentRef. */
  readonly instrumentAdmin: string;
  readonly instrumentId: string;
  /** Display symbol (e.g. "CBTC", "CC"). */
  readonly symbol: string;
  /** Human-readable issuer name. */
  readonly issuerName: string;
  /** True for the native Canton Coin (Amulet) holding. */
  readonly isCantonCoin: boolean;
  /** Decimal places for display (raw balances are minor units). */
  readonly decimals: number;
  /** Unlocked balance in minor units (string-encoded big integer). */
  readonly unlockedBalance: string;
  /** Locked balance in minor units (string-encoded big integer). */
  readonly lockedBalance: string;
  /** Wallet-specific extras (e.g. Loop's utxoCount + imagePath). */
  readonly extension?: Record<string, unknown>;
}

export type WalletHoldingsStrategy = 'loop' | 'canonical-acs' | 'unsupported';

export type WalletHoldingsResult =
  | { readonly strategy: 'loop' | 'canonical-acs'; readonly holdings: readonly WalletHolding[] }
  | {
      readonly strategy: 'unsupported';
      readonly holdings: readonly [];
      readonly reason: string;
    };

interface AdapterUnsupportedHint {
  readonly walletId: string;
  readonly humanName: string;
  readonly reason: string;
}

/**
 * Wallets that explicitly cannot satisfy holdings reads from the
 * dashboard, with a user-facing reason. Kept here rather than in
 * the per-adapter modules because the facade is where the UI
 * branches on this.
 */
const HOLDINGS_UNSUPPORTED: ReadonlyArray<AdapterUnsupportedHint> = [
  {
    walletId: 'cantor8',
    humanName: 'Cantor8',
    reason:
      "Cantor8's adapter only signs — it does not surface a ledger-read API to dApps. Open Cantor8 to see balances.",
  },
  {
    walletId: 'bron',
    humanName: 'Bron',
    reason:
      'Bron is OAuth-backed and does not expose a browser-side balances API. Open Bron to see balances.',
  },
];

/**
 * Resolve the active walletId from the current PartyLayer session.
 * Returns null if the dashboard is signed in via dapp-sdk (single-
 * wallet mode) or if no session is active.
 */
async function activeWalletId(): Promise<string | null> {
  if (walletClient.layer !== 'partylayer') return null;
  try {
    const accounts = await walletClient.listAccounts();
    return accounts[0]?.signingProviderId ?? null;
  } catch {
    return null;
  }
}

/**
 * Pick the right strategy for the currently-active wallet. Public
 * so the UI can choose its empty-state copy ahead of the actual
 * fetch.
 */
export async function pickStrategy(): Promise<{
  readonly strategy: WalletHoldingsStrategy;
  readonly walletId: string | null;
  readonly unsupportedReason?: string;
}> {
  const walletId = await activeWalletId();
  if (walletId === 'loop') return { strategy: 'loop', walletId };
  const unsupported = HOLDINGS_UNSUPPORTED.find((u) => u.walletId === walletId);
  if (unsupported) {
    return {
      strategy: 'unsupported',
      walletId,
      unsupportedReason: unsupported.reason,
    };
  }
  // Everything else with a working ledgerApi capability gets the
  // canonical ACS path. If the capability is false we still return
  // the canonical strategy and let the call throw at run time with
  // a clean error — better than a silent empty list.
  return { strategy: 'canonical-acs', walletId };
}

/**
 * Fetch wallet holdings for the currently-active session. Returns
 * `{ strategy: 'unsupported', reason }` rather than throwing for
 * known-unsupported wallets so the UI can render an actionable hint
 * without taking a TanStack-Query error code path.
 */
export async function getWalletHoldings(): Promise<WalletHoldingsResult> {
  const pick = await pickStrategy();
  if (pick.strategy === 'unsupported') {
    return {
      strategy: 'unsupported',
      holdings: [] as const,
      reason: pick.unsupportedReason ?? 'Wallet does not support holdings reads.',
    };
  }
  if (pick.strategy === 'loop') {
    if (!isLoopWalletActive()) {
      return {
        strategy: 'unsupported',
        holdings: [] as const,
        reason: 'No active Loop wallet session — sign in to load holdings.',
      };
    }
    const loop = await getLoopHoldings();
    return { strategy: 'loop', holdings: loop.map(loopToCommon) };
  }
  // canonical-acs path: Send, Nightly, Console.
  const acs = await queryHoldingsViaLedgerApi();
  return { strategy: 'canonical-acs', holdings: acs.map(acsToCommon) };
}

function loopToCommon(h: LoopHolding): WalletHolding {
  return {
    instrumentAdmin: h.instrumentAdmin,
    instrumentId: h.instrumentId,
    symbol: h.symbol,
    issuerName: h.issuerName,
    isCantonCoin: h.isCantonCoin,
    decimals: h.decimals,
    unlockedBalance: h.unlockedBalance,
    lockedBalance: h.lockedBalance,
    extension: {
      loop: {
        utxoCount: h.utxoCount,
        imagePath: h.imagePath,
      },
    },
  };
}

function acsToCommon(h: AcsHolding): WalletHolding {
  return {
    instrumentAdmin: h.instrumentAdmin,
    instrumentId: h.instrumentId,
    symbol: h.symbol ?? h.instrumentId,
    issuerName: h.issuerName ?? h.instrumentAdmin.split('::')[0] ?? h.instrumentAdmin,
    isCantonCoin: false,
    decimals: h.decimals ?? 0,
    unlockedBalance: h.amount,
    lockedBalance: '0',
  };
}
