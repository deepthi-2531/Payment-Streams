/**
 * Streams list — a person's recurring payments (paid straight from their wallet
 * each period). Rows lead with the counterparty and amount, not internal ids.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Zap, Search, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { useStreamsV1 } from '../hooks/useStreams.js';
import { useAuth } from '../store/auth.js';
import { LaneSwitch } from '../components/streams/LaneSwitch.js';
import { Skeleton, ErrorState, PageHeader } from '../components/common/index.js';
import { fmtAsset, assetOfView, displayName } from '../lib/format.js';
import type { V1StreamView } from '../api/client.js';

type DateRange = 'all' | 'today' | '7d' | '30d';

const RANGE_PRESETS: readonly { readonly id: DateRange; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

/** Epoch-ms cutoff for a preset; 0 means no lower bound. */
function rangeCutoff(range: DateRange): number {
  const now = Date.now();
  switch (range) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case '7d':
      return now - 7 * 86_400_000;
    case '30d':
      return now - 30 * 86_400_000;
    default:
      return 0;
  }
}

/** createdAt as epoch ms, 0 when absent/unparseable (sorts oldest/last). */
function createdMs(s: V1StreamView): number {
  const t = Date.parse(s.agreement.createdAt ?? '');
  return Number.isNaN(t) ? 0 : t;
}

export function V1StreamsPage() {
  const { party } = useAuth();
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRange>('all');
  const streamsQ = useStreamsV1();

  // Newest first (by createdAt), filtered by the search box and the date preset.
  const visible = useMemo<V1StreamView[]>(() => {
    const q = search.trim().toLowerCase();
    const cutoff = rangeCutoff(range);
    return (streamsQ.data ?? [])
      .filter(
        (s) =>
          !q ||
          `${s.agreement.payerParty} ${s.agreement.recipientParty}`.toLowerCase().includes(q),
      )
      .filter((s) => cutoff === 0 || createdMs(s) >= cutoff)
      .sort((a, b) => createdMs(b) - createdMs(a));
  }, [streamsQ.data, search, range]);

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Streams"
        subtitle="Recurring payments sent straight from your wallet each period."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <LaneSwitch lane="v1" kind="streams" />
            <Link to="/v1/create" className="btn btn-primary">
              <Zap size={14} /> New stream
            </Link>
          </div>
        }
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--bg-elev)', border: '1px solid var(--line-2)', borderRadius: 'var(--r-md)',
            padding: '6px 10px', minWidth: 220, maxWidth: 320,
          }}
        >
          <Search size={12} style={{ color: 'var(--fg-4)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name…"
            style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: 12.5, color: 'var(--fg)', width: '100%' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {RANGE_PRESETS.map((p) => {
            const on = range === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setRange(p.id)}
                style={{
                  cursor: 'pointer', fontSize: 11.5, padding: '6px 11px',
                  borderRadius: 'var(--r-md)', border: '1px solid var(--line-2)',
                  background: on ? 'var(--accent-soft)' : 'transparent',
                  color: on ? 'var(--accent)' : 'var(--fg-3)',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {streamsQ.isPending && <Skeleton.Row count={5} height={64} />}

      {streamsQ.isError && (
        <ErrorState error={streamsQ.error} title="Could not load streams" onRetry={() => streamsQ.refetch()} />
      )}

      {streamsQ.data && visible.length === 0 && !streamsQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <p style={{ margin: '0 0 14px', color: 'var(--fg-3)', fontSize: 13 }}>No streams yet.</p>
          <Link to="/v1/create" className="btn btn-primary" style={{ display: 'inline-flex' }}>
            <Zap size={14} /> Create your first stream
          </Link>
        </div>
      )}

      {visible.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {visible.map((s, i) => (
            <V1Row key={s.agreement.agreementId} view={s} party={party} last={i === visible.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function V1Row({
  view,
  party,
  last,
}: {
  readonly view: V1StreamView;
  readonly party: string | null;
  readonly last: boolean;
}) {
  const { agreement, state } = view;
  const outgoing = party != null && agreement.payerParty === party;
  const counterparty = outgoing ? agreement.recipientParty : agreement.payerParty;
  const per = agreement.cadence === 'hourly' ? 'hour' : agreement.cadence === 'minute' ? 'minute' : agreement.cadence === 'second' ? 'second' : 'day';

  return (
    <Link
      to={`/v1/streams/${encodeURIComponent(agreement.agreementId)}`}
      title={agreement.agreementId}
      style={{
        display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 1fr auto', alignItems: 'center', gap: 14,
        padding: '14px 18px', textDecoration: 'none', color: 'inherit',
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      {/* Counterparty */}
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        {outgoing ? (
          <ArrowUpRight size={15} style={{ color: 'var(--warn)', flexShrink: 0 }} />
        ) : (
          <ArrowDownLeft size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {outgoing ? 'To ' : 'From '}{displayName(counterparty)}
          </div>
          <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>
            {agreement.status === 'stopped' ? 'stopped' : 'active'}
          </span>
        </div>
      </div>

      {/* Rate */}
      <div>
        <span style={{ fontSize: 13, color: 'var(--fg)' }}>{fmtAsset(agreement.ratePerPeriod, assetOfView(agreement))}</span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--fg-4)' }}>per {per}</span>
      </div>

      {/* Payments sent */}
      <div>
        <span className="badge accent" style={{ fontSize: 11 }}>
          {state.cycles} {state.cycles === 1 ? 'payment' : 'payments'}
        </span>
      </div>

      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}
