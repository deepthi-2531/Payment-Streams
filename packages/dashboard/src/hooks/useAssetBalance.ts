/**
 * useAssetBalance — the connected wallet's spendable balance of a NON-CC stream
 * asset (e.g. USDCx), summed from its holdings on the wallet's own participant.
 *
 * CC lives behind `useCantonCoinBalance`; this covers the assets it can't read.
 * Reuses `readPayerHoldings` (the settle path's non-CC read) and sums the
 * spendable amounts. Returns a null display when the party holds no readable
 * holdings, so the UI shows a dash rather than a misleading 0.
 */
import { useQuery } from '@tanstack/react-query';
import { readPayerHoldings } from '../lib/settleV1Wallet.js';
import {
  HoldingsEmptyError,
  isHostedLedgerAvailable,
  isWalletRateLimited,
} from '../lib/hostedWalletLedger.js';
import type { StreamInstrument } from '../api/client.js';

export interface AssetBalance {
  /** Balance as a trimmed decimal string, or null when there is no readable
   *  holdings result (no wallet session / none held / still loading). */
  readonly display: string | null;
  readonly value: number | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** True once a holdings result has resolved for the active wallet session. */
  readonly available: boolean;
  readonly refetch: () => void;
}

/** Format a decimal without locale separators, so callers can re-parse it. */
function toDecimalString(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(10);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function useAssetBalance(
  party: string | undefined,
  instrument: StreamInstrument | undefined,
): AssetBalance {
  const instrumentId = instrument?.id;
  const enabled =
    !!party && !!instrumentId && instrumentId !== 'Amulet' && isHostedLedgerAvailable();

  const q = useQuery<number | null>({
    queryKey: ['asset-balance', party, instrumentId, instrument?.admin, instrument?.holdingTemplateId],
    enabled,
    // Hosted wallets rate-limit their holdings API, and this polls per open tab.
    // Keep it slow and skip focus refetches; the settle path reads fresh anyway.
    refetchInterval: 60_000,
    staleTime: 45_000,
    refetchOnWindowFocus: false,
    retry: (attempt, err) => (isWalletRateLimited(err) ? attempt < 2 : attempt < 1),
    retryDelay: (attempt) => Math.min(30_000, 5_000 * 2 ** attempt),
    queryFn: async () => {
      try {
        const holdings = await readPayerHoldings(party!, {
          instrumentId: instrumentId!,
          ...(instrument?.admin ? { instrumentAdmin: instrument.admin } : {}),
          ...(instrument?.holdingTemplateId ? { holdingTemplateId: instrument.holdingTemplateId } : {}),
        });
        return holdings.reduce((sum, h) => sum + h.amount, 0);
      } catch (err) {
        // Only a completed read that found nothing means "no balance" (a dash).
        // A failed read (throttled, transport, adapter) must surface as an error
        // so react-query keeps the last known balance instead of flipping to a
        // dash that reads as zero. Loop flattens its 429 into a generic message,
        // so classify on the error type, not the text.
        if (err instanceof HoldingsEmptyError) return null;
        throw err;
      }
    },
  });

  const resolved = q.data !== undefined;
  const value = resolved ? q.data : null;
  const display = value === null ? null : toDecimalString(value);

  return {
    display,
    value,
    isLoading: q.isFetching && !resolved,
    isError: q.isError,
    available: resolved,
    refetch: () => {
      void q.refetch();
    },
  };
}
