/**
 * V1StreamsPage — list of proxy V1 streams (GET /api/v1/streams).
 *
 * Distinct from the V2 `StreamsPage`: the V1 lane has its own data shape
 * (`V1StreamView`) and its own settle-cycle lifecycle, so it gets its own
 * list rather than a filter on the V2 table. Each row links to the V1
 * detail page keyed by `agreementId`.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Zap, Search, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { useStreamsV1 } from '../hooks/useStreams.js';
import { useAuth } from '../store/auth.js';
import { partyShort } from '../components/primitives/PartyChip.js';
import { LaneSwitch } from '../components/streams/LaneSwitch.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';
import type { V1StreamView } from '../api/client.js';

export function V1StreamsPage() {
  const { party } = useAuth();
  const [search, setSearch] = useState('');
  const streamsQ = useStreamsV1();

  const visible = useMemo<V1StreamView[]>(() => {
    if (!streamsQ.data) return [];
    if (!search.trim()) return [...streamsQ.data];
    const q = search.trim().toLowerCase();
    return streamsQ.data.filter((s) => {
      const haystack =
        `${s.agreement.agreementId} ${s.agreement.payerParty} ${s.agreement.recipientParty}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [streamsQ.data, search]);

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Streams"
        subtitle="Direct-delivery (V1) lane. Settle draws one cycle from the payer's wallet."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <LaneSwitch lane="v1" kind="streams" />
            <Link to="/v1/create" className="btn btn-primary">
              <Zap size={14} /> New V1 stream
            </Link>
          </div>
        }
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
          maxWidth: 320,
          marginBottom: 18,
        }}
      >
        <Search size={12} style={{ color: 'var(--fg-4)' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search id or party…"
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

      {streamsQ.isPending && <Skeleton.Row count={5} height={64} />}

      {streamsQ.isError && (
        <ErrorState
          error={streamsQ.error}
          title="Could not load V1 streams"
          onRetry={() => streamsQ.refetch()}
        />
      )}

      {streamsQ.data && visible.length === 0 && !streamsQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <p style={{ margin: '0 0 14px', color: 'var(--fg-3)', fontSize: 13 }}>
            No V1 streams yet.
          </p>
          <Link to="/v1/create" className="btn btn-primary" style={{ display: 'inline-flex' }}>
            <Zap size={14} /> Create your first V1 stream
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
  const { agreement, state, due } = view;
  const outgoing = party != null && agreement.payerParty === party;
  const counterparty = outgoing ? agreement.recipientParty : agreement.payerParty;

  return (
    <Link
      to={`/v1/streams/${encodeURIComponent(agreement.agreementId)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 1.6fr 1fr 1fr auto',
        alignItems: 'center',
        gap: 14,
        padding: '14px 18px',
        textDecoration: 'none',
        color: 'inherit',
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      {/* Stream id + direction */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {outgoing ? (
            <ArrowUpRight size={13} style={{ color: 'var(--warn)' }} />
          ) : (
            <ArrowDownLeft size={13} style={{ color: 'var(--accent)' }} />
          )}
          <span
            className="mono"
            style={{
              fontSize: 12.5,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={agreement.agreementId}
          >
            {agreement.agreementId}
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>
          {agreement.cadence} · {agreement.arrearsPolicy}
        </span>
      </div>

      {/* Counterparty */}
      <div style={{ minWidth: 0 }}>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          {outgoing ? 'to ' : 'from '}
          {counterparty.split('::')[0]}
        </span>
        <span className="mono" style={{ display: 'block', fontSize: 11, color: 'var(--fg-4)' }}>
          {partyShort(counterparty)}…
        </span>
      </div>

      {/* Rate */}
      <div>
        <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
          {agreement.ratePerPeriod} <span style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>CC</span>
        </span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--fg-4)' }}>
          per {agreement.cadence === 'hourly' ? 'hour' : 'day'}
        </span>
      </div>

      {/* Settled cycles */}
      <div>
        <span className="badge accent" style={{ fontSize: 11 }}>
          {state.cycles} {state.cycles === 1 ? 'cycle' : 'cycles'}
        </span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--fg-4)', marginTop: 4 }}>
          due {due}
        </span>
      </div>

      <ArrowUpRight size={14} style={{ color: 'var(--fg-4)' }} />
    </Link>
  );
}
