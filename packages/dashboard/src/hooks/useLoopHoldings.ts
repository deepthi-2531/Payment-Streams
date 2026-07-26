/**
 * useLoopHoldings — TanStack Query hook over Loop's REST
 * `/api/v1/.connect/pair/account/holding` endpoint.
 *
 * Used by the Dashboard's "Your wallet" panel. Returns an empty list and
 * stops polling when the user is not signed into Loop.
 *
 * Refetch cadence: 15 seconds. Hosted-wallet balances change at
 * transaction speed; tighter polling would hammer Loop's API for
 * minimal benefit. The cache invalidates immediately on a
 * `txChanged` event via the existing accounts-changed invalidator.
 */
import { useQuery } from '@tanstack/react-query';
import {
  getLoopHoldings,
  isLoopWalletActive,
  type LoopHolding,
} from '../lib/loopWallet.js';

export function useLoopHoldings() {
  return useQuery<readonly LoopHolding[]>({
    queryKey: ['loop-holdings'],
    queryFn: getLoopHoldings,
    enabled: isLoopWalletActive(),
    // Loop rate-limits this endpoint; poll gently and skip focus refetches.
    refetchInterval: 60_000,
    staleTime: 45_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
