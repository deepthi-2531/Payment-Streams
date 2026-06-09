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
import { walletClient } from '../store/wallet/index.js';

export function useWalletHoldings() {
  return useQuery<WalletHoldingsResult>({
    queryKey: ['wallet-holdings', walletClient.layer],
    queryFn: getWalletHoldings,
    // Only fetch when we're on a PartyLayer session — the dapp-sdk
    // path uses its own holdings UI today.
    enabled: walletClient.layer === 'partylayer',
    refetchInterval: 15_000,
    staleTime: 12_000,
    retry: 1,
  });
}
