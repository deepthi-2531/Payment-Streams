/**
 * Hook for display-only accrual calculation.
 *
 * Uses the SDK's BalanceTicker for real-time UI balance updates.
 * DISPLAY ONLY — the ledger is the authoritative source.
 */

import { useState, useEffect } from 'react';
import { BalanceTicker, getBalances } from '@canton-streams/sdk/browser';
import type { Stream, StreamBalances } from '@canton-streams/sdk/browser';

export function useAccrual(stream: Stream | null | undefined, intervalMs = 1000) {
  const [balances, setBalances] = useState<StreamBalances | null>(null);

  useEffect(() => {
    if (!stream) {
      setBalances(null);
      return;
    }

    // Compute initial balances
    setBalances(getBalances(stream));

    const ticker = new BalanceTicker(stream, intervalMs);
    ticker.onTick(setBalances);
    ticker.start();

    return () => {
      ticker.stop();
    };
  }, [stream, intervalMs]);

  return balances;
}
