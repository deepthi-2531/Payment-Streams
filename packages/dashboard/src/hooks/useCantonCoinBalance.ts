/**
 * useCantonCoinBalance — the connected wallet's spendable Canton Coin (CC /
 * Amulet) balance, in display + numeric form.
 *
 * Thin selector over `useWalletHoldings()` (the wallet-neutral holdings facade:
 * Loop REST, canonical CIP-0103 ACS, or unsupported). The V1 lane uses this to
 * show "you hold X CC" and to warn before a settle that would overdraw — so a
 * funding shortfall is visible up front instead of surfacing as a cryptic proxy
 * error at submit time.
 */
import { useWalletHoldings } from './useWalletHoldings.js';
import type { WalletHolding } from '../lib/walletHoldings.js';

/** Minor-unit integer string + decimals → a trimmed decimal display string. */
function minorToDecimalString(minor: string, decimals: number): string {
  if (!minor) return '0';
  // Defensive: if the wallet already handed us a decimal value (a '.' present),
  // it is NOT minor units — don't shift it again (that would double the point).
  if (minor.includes('.')) return minor;
  if (!decimals) return minor;
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(decimals + 1, '0');
  const intPart = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${frac ? `${intPart}.${frac}` : intPart}`;
}

export interface CantonCoinBalance {
  /** CC balance as a trimmed decimal string (e.g. "12.34"), or null when no
   *  holdings result is available yet (no PartyLayer session / still loading). */
  readonly display: string | null;
  /** Numeric value for comparisons (e.g. `value < rate`), or null. */
  readonly value: number | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** True once a holdings result has resolved for the active wallet session. */
  readonly available: boolean;
  readonly refetch: () => void;
}

export function useCantonCoinBalance(): CantonCoinBalance {
  const q = useWalletHoldings();
  const holdings: readonly WalletHolding[] = q.data?.holdings ?? [];
  const cc =
    holdings.find((h) => h.isCantonCoin) ??
    holdings.find((h) => h.symbol?.toUpperCase() === 'CC');

  const resolved = q.data !== undefined;
  const display = cc
    ? minorToDecimalString(cc.unlockedBalance, cc.decimals)
    : resolved
      ? '0'
      : null;
  const value = display === null ? null : Number(display);

  return {
    display,
    value,
    // A disabled TanStack query stays `isPending` forever; only report loading
    // while actually fetching and not yet resolved, so non-PartyLayer sessions
    // fall through to the "—" placeholder instead of a permanent spinner.
    isLoading: q.isFetching && !resolved,
    isError: q.isError,
    available: resolved,
    refetch: () => {
      void q.refetch();
    },
  };
}
