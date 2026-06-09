/**
 * SettlementBadge — chip displaying a stream's settlement mode.
 *
 * Labels mirror the SDK's `SettlementMode` enum:
 *   - `UtilityHoldingCustody` → "CIP Custody"
 *   - `TokenStandardCustody` → "Token Standard V2"
 *   - `LocalAssetCustody` → "Daml Finance"
 *   - `Delegated` → "Delegated"
 *   - `NumericLegacy` → "Numeric (sandbox)"
 */
const LABELS: Record<string, string> = {
  UtilityHoldingCustody: 'CIP Custody',
  TokenStandardCustody: 'Token Standard V2',
  LocalAssetCustody: 'Daml Finance',
  Delegated: 'Delegated',
  NumericLegacy: 'Numeric (sandbox)',
};

export interface SettlementBadgeProps {
  readonly mode: string;
}

export function SettlementBadge({ mode }: SettlementBadgeProps) {
  const label = LABELS[mode] ?? mode;
  return (
    <span
      className="badge"
      style={{
        background: 'transparent',
        borderColor: 'var(--line-2)',
        color: 'var(--fg-3)',
      }}
    >
      {label}
    </span>
  );
}
