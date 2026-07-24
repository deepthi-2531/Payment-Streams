import type { WalletLayer } from './types.js';

type DashboardEnv = Record<string, string | undefined>;

const env = (import.meta as unknown as { env?: DashboardEnv }).env ?? {};

function normalizeWalletLayer(value: string | undefined): WalletLayer {
  if (value === 'partylayer') return 'partylayer';
  if (value === 'combined') return 'combined';
  return 'dapp-sdk';
}

export const WALLET_LAYER = normalizeWalletLayer(
  env.VITE_WALLET_LAYER ?? env.VITE_WALLET_PROVIDER,
);

export const SKIP_PICKER = env.VITE_SKIP_WALLET_PICKER === 'true';

/** Combined layer: include PartyLayer's full wallet catalog (Console, Cantor8,
 * Nightly, Send, …) as disabled/"not installed" rows in addition to the
 * working defaults (5N Loop + the SWK gateway + discovered CIP-103 wallets).
 * Off by default so the picker only lists wallets that actually work here. */
export const SHOW_FULL_CATALOG =
  env.VITE_WALLET_SHOW_FULL_CATALOG === 'true';

export const WALLET_GATEWAY_URL =
  env.VITE_WALLET_GATEWAY_URL ?? 'http://localhost:3030/api/v0/dapp';

export const WALLET_NAME =
  env.VITE_WALLET_NAME ?? 'Splice Amulet Wallet';

export const PARTYLAYER_NETWORK =
  env.VITE_PARTYLAYER_NETWORK ?? env.VITE_WALLET_NETWORK ?? 'devnet';

export const PARTYLAYER_APP_NAME =
  env.VITE_PARTYLAYER_APP_NAME ?? 'Canton Payment Streams';

/** The Canton network this deployment targets. An on-load session restore only
 * adopts a persisted session whose network matches this. */
export const WALLET_NETWORK = env.VITE_WALLET_NETWORK ?? PARTYLAYER_NETWORK;

/** Upper bound (ms) on how long the on-load silent restore may hold the neutral
 * splash before falling back to the connect / reconnect screen. A malformed
 * value falls back to the default rather than firing the timeout immediately. */
export const RESTORE_TIMEOUT_MS = (() => {
  // Default covers Loop's 5s autoConnect so a Loop restore isn't cut short.
  const n = Number(env.VITE_WALLET_RESTORE_TIMEOUT_MS ?? '6000');
  return Number.isFinite(n) && n > 0 ? n : 6000;
})();
