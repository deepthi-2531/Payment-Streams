import type Decimal from 'decimal.js';

interface AmountDisplayProps {
  amount: Decimal;
  decimals?: number;
  className?: string;
}

export function AmountDisplay({ amount, decimals = 2, className }: AmountDisplayProps) {
  const formatted = Number(amount.toFixed(decimals)).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span className={className ?? 'tabular-nums font-medium'}>{formatted}</span>
  );
}
