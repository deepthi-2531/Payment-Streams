import type { CSSProperties } from 'react';
import { ArrowRight, Activity, Plus, ArrowDownToLine, XCircle, CheckCircle, RefreshCw } from 'lucide-react';
import type { Stream, StreamEvent } from '@canton-streams/sdk/browser';
import { StatusBadge } from '../common/StatusBadge.js';
import { BalanceDisplay } from './BalanceDisplay.js';
import { AccrualChart } from './AccrualChart.js';
import { WithdrawButton } from './WithdrawButton.js';
import { CancelDialog } from './CancelDialog.js';
import { useAccrual } from '../../hooks/useAccrual.js';
import { useStreamHistory } from '../../hooks/useStreams.js';
import { fmtCc, displayName } from '../../lib/format.js';

const sectionTitle: CSSProperties = { fontSize: 13, fontWeight: 500, color: 'var(--fg)', marginBottom: 14 };

export function StreamDetail({ stream }: { stream: Stream }) {
  const balances = useAccrual(stream);
  const { config, state } = stream;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, color: 'var(--fg)' }}>Payment to {displayName(config.recipient)}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5, color: 'var(--fg-3)' }}>
              <span title={config.sender}>{displayName(config.sender)}</span>
              <ArrowRight size={12} style={{ color: 'var(--fg-4)' }} />
              <span title={config.recipient}>{displayName(config.recipient)}</span>
            </div>
          </div>
          <StatusBadge status={state.status} />
        </div>
      </div>

      {/* Balance summary (already dark-themed) */}
      {balances && <BalanceDisplay balances={balances} />}

      {/* Chart */}
      <div className="card" style={{ padding: 20 }}>
        <div style={sectionTitle}>Over time</div>
        <AccrualChart stream={stream} />
      </div>

      {/* Details */}
      <div className="card" style={{ padding: 20 }}>
        <div style={sectionTitle}>Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Item label="Total funded" value={fmtCc(String(config.totalDeposited))} />
          <Item label="Paid out so far" value={fmtCc(String(state.totalWithdrawn))} />
          <Item label="Started" value={fmtDate(config.startTime)} />
          <Item label="Ends" value={fmtDate(config.endTime)} />
          <Item label="Can be cancelled" value={config.cancellable ? 'Yes, anytime' : 'No'} />
        </div>
      </div>

      {/* Activity */}
      <ActivityHistory sender={config.sender} streamId={config.streamId} />

      {/* Actions */}
      {state.status === 'Active' && (
        <div className="card" style={{ padding: 20 }}>
          <div style={sectionTitle}>Actions</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <WithdrawButton stream={stream} />
            {config.cancellable && <CancelDialog sender={config.sender} streamId={config.streamId} />}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-4)' }}>{label}</div>
      <div style={{ fontSize: 13.5, color: 'var(--fg)', marginTop: 3 }}>{value}</div>
    </div>
  );
}

function fmtDate(d: unknown): string {
  const date = d instanceof Date ? d : new Date(d as string);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const eventConfig: Record<string, { icon: typeof Plus; label: string }> = {
  created: { icon: Plus, label: 'Created' },
  withdrawn: { icon: ArrowDownToLine, label: 'Payment received' },
  cancelled: { icon: XCircle, label: 'Stopped' },
  completed: { icon: CheckCircle, label: 'Completed' },
  renewed: { icon: RefreshCw, label: 'Topped up' },
};

function ActivityHistory({ sender, streamId }: { sender: string; streamId: string }) {
  const { data: events, isLoading, error } = useStreamHistory(sender, streamId);

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Activity size={14} style={{ color: 'var(--fg-4)' }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>Activity</span>
      </div>

      {isLoading && <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-4)' }}>Loading…</p>}
      {error && <p style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>Couldn't load activity.</p>}
      {events && events.length === 0 && !isLoading && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-4)' }}>No activity yet.</p>
      )}

      {events && events.length > 0 && (
        <div style={{ display: 'grid', gap: 12 }}>
          {events.map((event: StreamEvent, idx: number) => {
            const cfg = eventConfig[event.type] ?? eventConfig['created']!;
            const Icon = cfg.icon;
            const ts = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp as unknown as string);
            return (
              <div key={`${event.type}-${idx}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elev)', color: 'var(--accent)', flexShrink: 0 }}>
                  <Icon size={13} />
                </div>
                <div style={{ flex: 1, minWidth: 0, paddingTop: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>{cfg.label}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>{ts.toLocaleString()}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
