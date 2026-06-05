/**
 * @module lib/loopWallet
 *
 * Direct Loop REST-API helpers. CIP-103's `ledgerApi` surface is
 * intentionally minimal (4 endpoints, no holdings method by
 * design), but the Loop SDK underneath exposes
 * `GET /api/v1/.connect/pair/account/holding` that returns the
 * user's full asset list — symbol, name, instrument admin party,
 * locked / unlocked balances, decimals. We call it directly using
 * the auth token that 5N Loop stashes in `localStorage.loop_connect`
 * after a successful sign-in.
 *
 * This is wallet-specific (Loop only). Other hosted wallets
 * (Cantor8, Send) each have their own native API; if/when the
 * dashboard adds those, each gets its own sibling module here
 * and a shared `hostedHoldings.ts` resolver picks the right one
 * based on `walletClient.layer` + the active wallet id.
 *
 * Endpoint contract (extracted from
 * `@fivenorth/loop-sdk@0.10.0/dist/index.js` `Connection.getHolding`):
 *
 *   GET https://devnet.cantonloop.com/api/v1/.connect/pair/account/holding
 *   Authorization: Bearer <auth_token from loop_connect>
 *
 *   ⇒ [
 *     {
 *       instrument_id: { admin: <party>, id: <token-id> },
 *       symbol: string,
 *       org_name: string,
 *       is_cc: boolean,
 *       decimals: number,                        // formatting; values are integer minor units
 *       total_unlocked_coin: string,             // integer string in minor units
 *       total_locked_coin: string,               // integer string in minor units
 *       total_utxos: number,
 *       merge_hint_balance: string,
 *       image: string                            // logo path under /api/v1/assets/...
 *     },
 *     ...
 *   ]
 *
 * Per-network apiUrl, copied from
 * `Connection` constructor in the Loop SDK:
 *
 *   local   → http://localhost:8080
 *   devnet  → https://devnet.cantonloop.com
 *   testnet → https://testnet.cantonloop.com
 *   mainnet → https://cantonloop.com
 */

import { walletClient } from '../store/wallet/index.js';

export interface LoopHolding {
  /** Loop's instrument admin party + canonical id — the (admin, id)
   *  pair that maps onto our `InstrumentRef`. */
  readonly instrumentAdmin: string;
  readonly instrumentId: string;
  /** Display symbol (e.g. "CBTC", "CC", "USDCx"). */
  readonly symbol: string;
  /** Human-readable issuer name (e.g. "Bitsafe", "Canton"). */
  readonly issuerName: string;
  /** Whether this is the native Canton Coin (Amulet) holding. */
  readonly isCantonCoin: boolean;
  /** Number of decimal places for display (raw values are minor units). */
  readonly decimals: number;
  /** Unlocked balance in minor units (string-encoded big integer). */
  readonly unlockedBalance: string;
  /** Locked balance in minor units (string-encoded big integer). */
  readonly lockedBalance: string;
  /** Number of underlying UTXOs/holdings the wallet has merged into
   *  this single row. Useful for the create-stream flow when the
   *  Daml `holdingCid` would need to be resolved. */
  readonly utxoCount: number;
  /** Logo path, relative to the Loop API URL (`<apiUrl>${image}`). */
  readonly imagePath?: string;
}

interface LoopHoldingApiResponse {
  readonly instrument_id?: { readonly admin?: string; readonly id?: string };
  readonly symbol?: string;
  readonly org_name?: string;
  readonly is_cc?: boolean;
  readonly decimals?: number;
  readonly total_unlocked_coin?: string;
  readonly total_locked_coin?: string;
  readonly total_utxos?: number;
  readonly image?: string;
}

interface LoopConnectStorage {
  readonly authToken?: string;
  readonly auth_token?: string;
  readonly partyId?: string;
}

const LOOP_API_URLS: Record<string, string> = {
  local: 'http://localhost:8080',
  devnet: 'https://devnet.cantonloop.com',
  dev: 'https://devnet.cantonloop.com',
  testnet: 'https://testnet.cantonloop.com',
  test: 'https://testnet.cantonloop.com',
  mainnet: 'https://cantonloop.com',
  main: 'https://cantonloop.com',
};

/**
 * Map a CAIP-2 network id (e.g. `canton:da-devnet`) onto Loop's
 * shorthand network string (`devnet`, `testnet`, `mainnet`). Loop
 * uses these strings to pick its `apiUrl`; we mirror the SDK's
 * `Connection` constructor switch statement.
 */
function loopNetworkFromCaip2(networkId: string | undefined): string {
  if (!networkId) return 'devnet';
  const lower = networkId.toLowerCase();
  if (lower.includes('main')) return 'mainnet';
  if (lower.includes('test')) return 'testnet';
  if (lower.includes('local')) return 'local';
  return 'devnet';
}

export class LoopWalletNotConnectedError extends Error {
  constructor(message?: string) {
    super(message ?? 'No active Loop wallet session');
    this.name = 'LoopWalletNotConnectedError';
  }
}

/**
 * True when the active wallet session is 5N Loop and we have an
 * auth token to call Loop's REST API.
 */
export function isLoopWalletActive(): boolean {
  if (walletClient.layer !== 'partylayer') return false;
  try {
    const raw = localStorage.getItem('loop_connect');
    if (!raw) return false;
    const session = JSON.parse(raw) as LoopConnectStorage;
    return Boolean(session.authToken ?? session.auth_token);
  } catch {
    return false;
  }
}

/**
 * Fetch the user's holdings from Loop. Returns a normalized
 * `LoopHolding[]` (one row per (instrumentAdmin, instrumentId)
 * pair, with both unlocked and locked balances).
 *
 * Throws:
 *   - `LoopWalletNotConnectedError` if there's no Loop session
 *     in localStorage (the user needs to sign in to Loop).
 *   - A generic `Error` for HTTP failures (token expired, network
 *     down, Loop API outage). Callers should surface these to the
 *     user with a "Refresh" CTA rather than swallowing.
 */
export async function getLoopHoldings(): Promise<readonly LoopHolding[]> {
  const raw = localStorage.getItem('loop_connect');
  if (!raw) throw new LoopWalletNotConnectedError();
  let session: LoopConnectStorage;
  try {
    session = JSON.parse(raw) as LoopConnectStorage;
  } catch {
    throw new LoopWalletNotConnectedError(
      'Loop session data could not be parsed — try re-signing into the wallet.',
    );
  }
  const token = session.authToken ?? session.auth_token;
  if (!token) {
    throw new LoopWalletNotConnectedError(
      'Loop session has no auth token — try re-signing into the wallet.',
    );
  }

  // Pick the right Loop API URL based on the wallet's network.
  const status = await walletClient.status();
  const network = loopNetworkFromCaip2(status?.network?.networkId);
  const apiUrl = LOOP_API_URLS[network] ?? LOOP_API_URLS.devnet;

  const res = await fetch(`${apiUrl}/api/v1/.connect/pair/account/holding`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new LoopWalletNotConnectedError(
      'Loop rejected the session token — re-sign into the wallet from the picker.',
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Loop holdings API returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    );
  }
  const data = (await res.json()) as LoopHoldingApiResponse[];
  if (!Array.isArray(data)) return [];

  return data
    .map((h): LoopHolding | null => {
      const admin = h.instrument_id?.admin;
      const id = h.instrument_id?.id;
      if (!admin || !id) return null;
      return {
        instrumentAdmin: admin,
        instrumentId: id,
        symbol: h.symbol ?? id,
        issuerName: h.org_name ?? id,
        isCantonCoin: Boolean(h.is_cc),
        decimals: typeof h.decimals === 'number' ? h.decimals : 0,
        unlockedBalance: h.total_unlocked_coin ?? '0',
        lockedBalance: h.total_locked_coin ?? '0',
        utxoCount: typeof h.total_utxos === 'number' ? h.total_utxos : 0,
        imagePath: h.image,
      };
    })
    .filter((h): h is LoopHolding => h !== null);
}

/**
 * Resolve a logo URL for a `LoopHolding`. The wallet returns a
 * relative path under `/api/v1/assets/...`; join it against the
 * network's apiUrl. Returns null if the holding has no logo.
 */
export async function getLoopHoldingLogoUrl(
  holding: LoopHolding,
): Promise<string | null> {
  if (!holding.imagePath) return null;
  const status = await walletClient.status();
  const network = loopNetworkFromCaip2(status?.network?.networkId);
  const apiUrl = LOOP_API_URLS[network] ?? LOOP_API_URLS.devnet;
  return `${apiUrl}${holding.imagePath}`;
}

/**
 * Format a Loop holding's balance for display. The wire balance
 * is a string-encoded big integer in minor units; we shift by
 * `decimals` and trim trailing zeros for the symbol-side display.
 *
 * For very large or fractional balances we delegate to `Intl`
 * when possible, but we never lose precision (the underlying
 * value remains the source of truth for any submission).
 */
export function formatLoopBalance(holding: LoopHolding, balanceRaw?: string): string {
  const raw = balanceRaw ?? holding.unlockedBalance;
  if (!raw) return '0';
  if (holding.decimals === 0) return raw;
  // Insert the decimal point at position `decimals` from the end.
  const padded = raw.padStart(holding.decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - holding.decimals);
  const fracPart = padded.slice(padded.length - holding.decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}
