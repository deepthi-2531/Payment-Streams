/**
 * LaneSwitch — flip between the two delivery modes from a single "Streams" /
 * "Create" entry point, instead of separate nav tabs. Both are token-standard
 * V2 under the hood; they differ in how funds move:
 *
 *   • Direct delivery (default): a token-standard transfer per cycle from the
 *     payer's wallet (/v1/streams, /v1/create). Works with any wallet.
 *   • Custody (advanced): an allocation-backed StreamAdmin (/streams, /create).
 *     Requires the canton-streams DAR on the payer's participant, so it is not
 *     offered to custodial wallets (Loop) whose participant can't run it.
 *
 * Selecting a mode just navigates to that route; each keeps its own page + data
 * source, but the user sees one tab with a dropdown.
 */

import { useNavigate } from 'react-router';
import { useAuth } from '../../store/auth.js';

const ROUTES = {
  streams: { v2: '/streams', v1: '/v1/streams' },
  create: { v2: '/create', v1: '/v1/create' },
} as const;

export function LaneSwitch({
  lane,
  kind,
}: {
  readonly lane: 'v1' | 'v2';
  readonly kind: 'streams' | 'create';
}) {
  const navigate = useNavigate();
  const { canCreateCustodyStream } = useAuth();
  // Only one delivery mode is available (e.g. a Loop wallet) → a single-option
  // dropdown is pure clutter, so hide the switch entirely.
  if (!canCreateCustodyStream) return null;
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: 'var(--fg-3)',
        whiteSpace: 'nowrap',
      }}
      title="Switch delivery mode"
    >
      Delivery
      <select
        value={lane}
        onChange={(e) => navigate(ROUTES[kind][e.target.value as 'v1' | 'v2'])}
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--line-2)',
          borderRadius: 'var(--r-sm)',
          color: 'var(--fg)',
          fontSize: 12.5,
          padding: '6px 10px',
          cursor: 'pointer',
        }}
      >
        <option value="v1">Direct delivery (default)</option>
        {/* Custody needs the streams DAR on the payer's participant — hide it
            from wallets that can't run it so they don't hit a doomed create. */}
        {canCreateCustodyStream && <option value="v2">Custody (advanced)</option>}
      </select>
    </label>
  );
}
