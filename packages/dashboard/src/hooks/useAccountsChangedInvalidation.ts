/**
 * useAccountsChangedInvalidation — when the connected wallet party
 * changes (or disconnects), invalidate every TanStack query so the
 * dashboard refetches against the new identity.
 *
 * Why this is needed: our query keys (`['streams', filter]`,
 * `['stream-requests', filter]`, `['stream', sender, streamId]`,
 * `['policies']`, `['execution-logs']`, …) don't include the connected
 * `party` because the proxy uses the wallet-issued bearer token to scope
 * results server-side. When the user switches accounts inside their
 * wallet picker, the dapp-sdk emits `accountsChanged`; our `auth.tsx`
 * surfaces the new `party` value; this hook listens to that change and
 * tells TanStack to refetch.
 *
 * Without this, the dashboard would serve stale cached results from the
 * previous party until manual refresh.
 *
 * STR-123 Phase 7.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../store/auth.js';

export function useAccountsChangedInvalidation(): void {
  const { party } = useAuth();
  const queryClient = useQueryClient();
  const prev = useRef<string | null>(party);

  useEffect(() => {
    // Skip the first render — `party` going from null → "alice" on
    // initial connect is normal and the queries are already enabled
    // by the `useCantonClient`-derived `enabled: !!client` gate.
    if (prev.current === party) return;
    const wasConnected = prev.current !== null;
    const isConnected = party !== null;
    prev.current = party;

    // Account switch OR disconnect: drop ALL cached query results.
    // This covers:
    //   - alice → bob   (party changed)
    //   - alice → null  (disconnect)
    //   - null  → alice (first connect — defensive; queries weren't enabled yet)
    if (wasConnected || isConnected) {
      void queryClient.invalidateQueries();
    }
  }, [party, queryClient]);
}
