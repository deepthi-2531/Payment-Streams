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
import { isHostedLedgerAvailable } from '../lib/hostedWalletLedger.js';
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
    refetchInterval: 15_000,
    staleTime: 12_000,
    retry: 1,
    queryFn: async () => {
      try {
        const holdings = await readPayerHoldings(party!, {
          instrumentId: instrumentId!,
          ...(instrument?.admin ? { instrumentAdmin: instrument.admin } : {}),
          ...(instrument?.holdingTemplateId ? { holdingTemplateId: instrument.holdingTemplateId } : {}),
        });
        return holdings.reduce((sum, h) => sum + h.amount, 0);
      } catch {
        // readPayerHoldings throws when the wallet holds no spendable holdings of
        // this asset — surface that as "no readable balance" (a dash), not 0.
        return null;
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
