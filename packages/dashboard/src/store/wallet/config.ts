import type { WalletLayer } from './types.js';

type DashboardEnv = Record<string, string | undefined>;

const env = (import.meta as unknown as { env?: DashboardEnv }).env ?? {};

function normalizeWalletLayer(value: string | undefined): WalletLayer {
  if (value === 'partylayer') return 'partylayer';
  return 'dapp-sdk';
}

export const WALLET_LAYER = normalizeWalletLayer(
  env.VITE_WALLET_LAYER ?? env.VITE_WALLET_PROVIDER,
);

export const SKIP_PICKER = env.VITE_SKIP_WALLET_PICKER === 'true';

export const WALLET_GATEWAY_URL =
  env.VITE_WALLET_GATEWAY_URL ?? 'http://localhost:3030/api/v0/dapp';

export const WALLET_NAME =
  env.VITE_WALLET_NAME ?? 'Splice Amulet Wallet (LocalNet V2)';
