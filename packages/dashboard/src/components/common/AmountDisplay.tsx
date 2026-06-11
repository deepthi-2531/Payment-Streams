import type Decimal from 'decimal.js';

interface AmountDisplayProps {
  amount: Decimal;
  decimals?: number;
  className?: string;
}

/**
 * Format a Decimal amount with locale digit grouping without converting the
 * value through a float, so large amounts keep full precision.
 */
export function formatAmount(amount: Decimal, decimals = 2): string {
  const fixed = amount.toFixed(decimals);
  const negative = fixed.startsWith('-');
  const [whole = '0', frac] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = BigInt(whole).toLocaleString();
  return `${negative ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

export function AmountDisplay({ amount, decimals = 2, className }: AmountDisplayProps) {
  return (
    <span className={className ?? 'tabular-nums font-medium'}>
      {formatAmount(amount, decimals)}
    </span>
  );
}
