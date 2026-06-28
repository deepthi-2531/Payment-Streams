/**
 * Streams list page.
 *
 * Filter chips → direction (all/in/out) + status (Active/Completed/Cancelled).
 * Table re-uses the existing `StreamsTable` component (also reskinned).
 * Pending requests preview as a thin section above the table.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Plus, SlidersHorizontal, Search } from 'lucide-react';
import { StreamStatus } from '@canton-streams/sdk/browser';
import { usePendingStreamRequests, useStreams } from '../hooks/useStreams.js';
import { useAuth } from '../store/auth.js';
import { StreamsTable } from '../components/streams/StreamsTable.js';
import { PendingRequestsPanel } from '../components/streams/PendingRequestsPanel.js';
import { LaneSwitch } from '../components/streams/LaneSwitch.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';

type DirectionFilter = 'all' | 'in' | 'out';
type StatusFilter = '' | StreamStatus;

export function StreamsPage() {
  const { party } = useAuth();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [search, setSearch] = useState('');

  const filter = statusFilter ? { status: statusFilter as StreamStatus } : undefined;
  const streamsQ = useStreams(filter);
  const pendingQ = usePendingStreamRequests();

  // Direction + search filter applied client-side because the proxy API
  // doesn't currently expose those filters server-side.
  const visible = useMemo(() => {
    if (!streamsQ.data) return [];
    return streamsQ.data.filter((s) => {
      if (directionFilter === 'in' && (!party || s.config.recipient !== party)) return false;
      if (directionFilter === 'out' && (!party || s.config.sender !== party)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = `${s.config.streamId} ${s.config.sender} ${s.config.recipient}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [streamsQ.data, directionFilter, search, party]);

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Streams"
        subtitle="Browse and manage all payment streams"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <LaneSwitch lane="v2" kind="streams" />
            <Link to="/create" className="btn btn-primary">
              <Plus size={14} /> New stream
            </Link>
          </div>
        }
      />

      {/* Filter bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-3)', fontSize: 12 }}>
          <SlidersHorizontal size={14} />
          <span style={{ fontWeight: 500 }}>Filter</span>
        </div>

        {/* Direction */}
        <ChipGroup
          value={directionFilter}
          onChange={(v) => setDirectionFilter(v as DirectionFilter)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'in', label: 'Incoming' },
            { value: 'out', label: 'Outgoing' },
          ]}
        />

        {/* Status */}
        <ChipGroup
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
          options={[
            { value: '', label: 'Any status' },
            { value: StreamStatus.Active, label: 'Active' },
            { value: StreamStatus.Completed, label: 'Completed' },
            { value: StreamStatus.Cancelled, label: 'Cancelled' },
          ]}
        />

        {/* Search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'var(--bg-elev)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-md)',
            padding: '6px 10px',
            minWidth: 220,
            marginLeft: 'auto',
          }}
        >
          <Search size={12} style={{ color: 'var(--fg-4)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stream id or party…"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 12.5,
              color: 'var(--fg)',
              width: '100%',
            }}
          />
        </div>
      </div>

      {/* Pending preview */}
      {pendingQ.data && pendingQ.data.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <PendingRequestsPanel requests={pendingQ.data} />
        </div>
      )}

      {/* Table area */}
      {streamsQ.isPending && <Skeleton.Row count={6} height={56} />}

      {streamsQ.isError && (
        <ErrorState
          error={streamsQ.error}
          title="Could not load streams"
          onRetry={() => streamsQ.refetch()}
        />
      )}

      {streamsQ.data && visible.length === 0 && !streamsQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <p style={{ margin: 0, color: 'var(--fg-3)', fontSize: 13 }}>
            No streams match the current filters.
          </p>
        </div>
      )}

      {visible.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <StreamsTable streams={visible} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ChipGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  readonly value: T;
  readonly onChange: (v: T) => void;
  readonly options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        background: 'var(--bg-elev)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '5px 12px',
              borderRadius: 'var(--r-sm)',
              fontSize: 12,
              fontWeight: 500,
              color: active ? 'var(--accent)' : 'var(--fg-3)',
              background: active ? 'var(--accent-soft)' : 'transparent',
              transition: 'background 120ms, color 120ms',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
