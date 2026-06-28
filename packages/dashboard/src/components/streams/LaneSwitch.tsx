/**
 * LaneSwitch — flip between the two settlement lanes from a single "Streams" /
 * "Create" entry point, instead of separate nav tabs.
 *
 *   • Token Standard (V2): the CIP-56 AllocationRequest lane (/streams, /create)
 *   • Direct delivery (V1): the TransferFactory lane (/v1/streams, /v1/create)
 *
 * Selecting a lane just navigates to that lane's route; each lane keeps its own
 * page + data source, but the user sees one tab with a dropdown.
 */

import { useNavigate } from 'react-router';

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
      title="Switch settlement lane"
    >
      Lane
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
        <option value="v2">Token Standard (V2)</option>
        <option value="v1">Direct delivery (V1)</option>
      </select>
    </label>
  );
}
