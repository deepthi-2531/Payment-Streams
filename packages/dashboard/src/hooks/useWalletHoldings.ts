/**
 * useWalletHoldings — wallet-neutral TanStack Query hook for
 * the dashboard's holdings reads. Dispatches via
 * `getWalletHoldings()` to the right per-wallet adapter (Loop
 * REST, canonical CIP-0103 ACS, or unsupported-with-reason).
 *
 * Replaces the earlier Loop-specific `useLoopHoldings` so call
 * sites don't have to know which wallet is active.
 */
import { useQuery } from '@tanstack/react-query';
import { getWalletHoldings, type WalletHoldingsResult } from '../lib/walletHoldings.js';
import { isWalletRateLimited } from '../lib/hostedWalletLedger.js';
import { walletClient } from '../store/wallet/index.js';

export function useWalletHoldings() {
  return useQuery<WalletHoldingsResult>({
    queryKey: ['wallet-holdings', walletClient.layer],
    queryFn: getWalletHoldings,
    // Only fetch when we're on a PartyLayer session — the dapp-sdk
    // path uses its own holdings UI today.
    enabled: walletClient.layer === 'partylayer',
    // Hosted wallets rate-limit their holdings API; poll gently.
    refetchInterval: 60_000,
    staleTime: 45_000,
    refetchOnWindowFocus: false,
    // Loop's REST holdings call surfaces a real "HTTP 429" — worth a backed-off
    // retry rather than showing the user a failure they can't act on.
    retry: (attempt, err) => (isWalletRateLimited(err) ? attempt < 2 : attempt < 1),
    retryDelay: (attempt) => Math.min(30_000, 5_000 * 2 ** attempt),
  });
}
