/**
 * VestingBadge — chip displaying a stream's vesting mode.
 *
 * Accepts either:
 *   - the structured `VestingMode` enum value from the SDK ('Linear' | 'CliffLinear' | ...)
 *   - or a structured config object with a `mode` field (the mock's shape)
 */
const LABELS: Record<string, string> = {
  Linear: 'Linear',
  CliffLinear: 'Cliff',
  Stepped: 'Stepped',
  RenewableTerm: 'Renewable',
};

export interface VestingBadgeProps {
  readonly vesting: string | { readonly mode: string };
}

export function VestingBadge({ vesting }: VestingBadgeProps) {
  const mode = typeof vesting === 'string' ? vesting : vesting.mode;
  const label = LABELS[mode] ?? mode;
  return (
    <span
      className="badge muted"
      style={{ background: 'transparent', borderColor: 'var(--line-2)' }}
    >
      {label}
    </span>
  );
}
