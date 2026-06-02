import {
  Calendar,
  Clock,
  Hash,
  ArrowRight,
  Shield,
  Coins,
  FileText,
  Lock,
  Activity,
  CheckCircle,
  XCircle,
  ArrowDownToLine,
  RefreshCw,
  Plus,
} from 'lucide-react';
import type { Stream, StreamEvent } from '@canton-streams/sdk/browser';
import { AssetType, SettlementMode } from '@canton-streams/sdk/browser';
import { StatusBadge } from '../common/StatusBadge.js';
import { AmountDisplay } from '../common/AmountDisplay.js';
import { BalanceDisplay } from './BalanceDisplay.js';
import { AccrualChart } from './AccrualChart.js';
import { WithdrawButton } from './WithdrawButton.js';
import { CancelDialog } from './CancelDialog.js';
import { useAccrual } from '../../hooks/useAccrual.js';
import { useStreamHistory } from '../../hooks/useStreams.js';

/**
 * Display a Canton party ID with the hint prominent and fingerprint subtle.
 */
function PartyDisplay({ partyId }: { partyId: string }) {
  const sep = partyId.indexOf('::');
  if (sep <= 0) return <span className="font-mono text-sm text-gray-900 break-all">{partyId}</span>;
  const hint = partyId.slice(0, sep);
  const fingerprint = partyId.slice(sep);
  return (
    <span className="font-mono text-sm" title={partyId}>
      <span className="font-semibold text-gray-900">{hint}</span>
      <span className="text-gray-400 text-xs">{fingerprint.slice(0, 14)}...</span>
    </span>
  );
}

interface StreamDetailProps {
  stream: Stream;
}

export function StreamDetail({ stream }: StreamDetailProps) {
  const balances = useAccrual(stream);
  const { config, state } = stream;

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50">
                <Hash className="h-5 w-5 text-brand-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Stream {config.streamId.slice(0, 8)}...
                </h2>
                <p className="text-xs text-gray-400 font-mono mt-0.5">{config.streamId}</p>
              </div>
            </div>
          </div>
          <StatusBadge status={state.status} />
        </div>

        {/* Party flow */}
        <div className="mt-6 flex items-center gap-3 rounded-xl bg-gray-50 px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Sender
            </p>
            <PartyDisplay partyId={config.sender} />
          </div>
          <ArrowRight className="h-4 w-4 text-gray-300 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Recipient
            </p>
            <PartyDisplay partyId={config.recipient} />
          </div>
        </div>
      </div>

      {/* Balances (display only) */}
      {balances && <BalanceDisplay balances={balances} />}

      {/* Chart */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Accrual Timeline</h3>
        <AccrualChart stream={stream} />
      </div>

      {/* Config details */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Configuration</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <ConfigItem
            icon={<Hash className="h-4 w-4" />}
            label="Total Deposited"
            value={
              <AmountDisplay
                amount={config.totalDeposited}
                className="text-sm font-semibold text-gray-900 tabular-nums"
              />
            }
          />
          <ConfigItem
            icon={<Hash className="h-4 w-4" />}
            label="Total Withdrawn"
            value={
              <AmountDisplay
                amount={state.totalWithdrawn}
                className="text-sm font-semibold text-gray-900 tabular-nums"
              />
            }
          />
          <ConfigItem
            icon={<Clock className="h-4 w-4" />}
            label="Start Time"
            value={
              <span className="text-sm text-gray-900">{config.startTime.toLocaleString()}</span>
            }
          />
          <ConfigItem
            icon={<Clock className="h-4 w-4" />}
            label="End Time"
            value={<span className="text-sm text-gray-900">{config.endTime.toLocaleString()}</span>}
          />
          <ConfigItem
            icon={<Lock className="h-4 w-4" />}
            label="Settlement"
            value={<SettlementModeBadge mode={config.settlementMode} />}
          />
          <ConfigItem
            icon={<Coins className="h-4 w-4" />}
            label="Asset Mode"
            value={<AssetModeBadge assetType={config.assetType} />}
          />
          <ConfigItem
            icon={<Calendar className="h-4 w-4" />}
            label="Vesting Mode"
            value={
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                {config.vestingMode.mode}
              </span>
            }
          />
          <ConfigItem
            icon={<Shield className="h-4 w-4" />}
            label="Cancellable"
            value={
              <span
                className={`text-sm font-medium ${config.cancellable ? 'text-amber-600' : 'text-gray-500'}`}
              >
                {config.cancellable ? 'Yes' : 'No'}
              </span>
            }
          />
        </div>
      </div>

      {/* Instrument Reference */}
      {config.instrumentRef && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Instrument Reference</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <ConfigItem
              icon={<FileText className="h-4 w-4" />}
              label="Instrument ID"
              value={
                <span className="text-sm font-mono text-gray-900">
                  {config.instrumentRef.instrumentId}
                </span>
              }
            />
            <ConfigItem
              icon={<FileText className="h-4 w-4" />}
              label="Version"
              value={
                <span className="text-sm font-mono text-gray-900">
                  {config.instrumentRef.instrumentVersion}
                </span>
              }
            />
            <ConfigItem
              icon={<Hash className="h-4 w-4" />}
              label="Depository"
              value={<PartyDisplay partyId={config.instrumentRef.depository} />}
            />
            <ConfigItem
              icon={<Hash className="h-4 w-4" />}
              label="Issuer"
              value={<PartyDisplay partyId={config.instrumentRef.issuer} />}
            />
          </div>
        </div>
      )}

      {/* Escrow Details — shown for custody-backed streams */}
      {stream.escrowRef && (
        <div className="rounded-2xl border border-indigo-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Escrow Custody Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <ConfigItem
              icon={<Lock className="h-4 w-4" />}
              label="Escrow Holding CID"
              value={
                <span
                  className="text-sm font-mono text-gray-900 break-all"
                  title={stream.escrowRef.escrowHoldingCid}
                >
                  {stream.escrowRef.escrowHoldingCid.slice(0, 16)}...
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(stream.escrowRef!.escrowHoldingCid)
                    }
                    className="ml-1.5 text-gray-400 hover:text-brand-600 text-[10px]"
                    title="Copy full CID"
                  >
                    copy
                  </button>
                </span>
              }
            />
            <ConfigItem
              icon={<Coins className="h-4 w-4" />}
              label="Escrow Amount"
              value={
                <span className="text-sm font-semibold text-gray-900 tabular-nums">
                  {stream.escrowRef.escrowAmount}
                </span>
              }
            />
            <ConfigItem
              icon={<Hash className="h-4 w-4" />}
              label="Escrow Operator"
              value={<PartyDisplay partyId={stream.escrowRef.escrowOperator} />}
            />
            {stream.escrowRef.instrumentRef && (
              <ConfigItem
                icon={<FileText className="h-4 w-4" />}
                label="Instrument"
                value={
                  <span className="text-sm font-mono text-gray-900">
                    {stream.escrowRef.instrumentRef.instrumentId}@
                    {stream.escrowRef.instrumentRef.instrumentVersion}
                  </span>
                }
              />
            )}
          </div>
        </div>
      )}

      {/* Activity History */}
      <ActivityHistory sender={config.sender} streamId={config.streamId} />

      {/* Actions */}
      {state.status === 'Active' && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Actions</h3>
          <div className="flex gap-3">
            <WithdrawButton stream={stream} />
            {config.cancellable && (
              <CancelDialog sender={config.sender} streamId={config.streamId} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 text-gray-400 flex-shrink-0 mt-0.5">
        {icon}
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <div className="mt-0.5">{value}</div>
      </div>
    </div>
  );
}

const assetModeLabels: Record<string, { label: string; description: string; color: string }> = {
  [AssetType.ValidatorLocalAsset]: {
    label: 'Local Token',
    description: 'Validator-local private asset',
    color: 'bg-gray-100 text-gray-700',
  },
  [AssetType.LocalCip56]: {
    label: 'CIP-56 Local',
    description: 'CIP-56 token on local environment',
    color: 'bg-blue-50 text-blue-700',
  },
  [AssetType.GlobalCip56]: {
    label: 'CIP-56 Global',
    description: 'CIP-56 token with global interoperability',
    color: 'bg-brand-50 text-brand-700',
  },
};

const settlementLabels: Record<string, { label: string; description: string; color: string }> = {
  [SettlementMode.NumericLegacy]: {
    label: 'Legacy',
    description: 'Numeric bookkeeping escrow (deprecated)',
    color: 'bg-gray-100 text-gray-500',
  },
  [SettlementMode.UtilityHoldingCustody]: {
    label: 'CIP Custody',
    description: 'Utility/CIP holding-backed custody — real transfers',
    color: 'bg-indigo-50 text-indigo-700',
  },
  [SettlementMode.TokenStandardCustody]: {
    label: 'Token Standard V2',
    description: 'CIP-56 V2 / CIP-0112 AllocationRequest custody',
    color: 'bg-brand-50 text-brand-700',
  },
  [SettlementMode.LocalAssetCustody]: {
    label: 'Daml Finance Custody',
    description: 'Generic Daml Finance holding custody — real transfers',
    color: 'bg-emerald-50 text-emerald-700',
  },
};

function SettlementModeBadge({ mode }: { mode?: string }) {
  const info = settlementLabels[mode ?? SettlementMode.TokenStandardCustody] ?? {
    label: mode ?? 'Unknown',
    description: '',
    color: 'bg-gray-100 text-gray-600',
  };
  return (
    <div>
      <span
        className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${info.color}`}
      >
        {info.label}
      </span>
      {info.description && <p className="mt-0.5 text-[10px] text-gray-400">{info.description}</p>}
    </div>
  );
}

function AssetModeBadge({ assetType }: { assetType: string }) {
  const info = assetModeLabels[assetType] ?? {
    label: assetType,
    description: '',
    color: 'bg-gray-100 text-gray-600',
  };
  return (
    <div>
      <span
        className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${info.color}`}
      >
        {info.label}
      </span>
      {info.description && <p className="mt-0.5 text-[10px] text-gray-400">{info.description}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity History
// ---------------------------------------------------------------------------

const eventConfig: Record<string, { icon: typeof Plus; label: string; color: string; bg: string }> =
  {
    created: { icon: Plus, label: 'Stream Created', color: 'text-brand-600', bg: 'bg-brand-50' },
    withdrawn: {
      icon: ArrowDownToLine,
      label: 'Withdrawal',
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
    cancelled: { icon: XCircle, label: 'Cancelled', color: 'text-red-600', bg: 'bg-red-50' },
    completed: { icon: CheckCircle, label: 'Completed', color: 'text-blue-600', bg: 'bg-blue-50' },
    renewed: { icon: RefreshCw, label: 'Renewed', color: 'text-amber-600', bg: 'bg-amber-50' },
  };

function ActivityHistory({ sender, streamId }: { sender: string; streamId: string }) {
  const { data: events, isLoading, error } = useStreamHistory(sender, streamId);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-4 w-4 text-gray-400" />
        <h3 className="text-sm font-semibold text-gray-900">Activity History</h3>
        {events && events.length > 0 && (
          <span className="ml-auto text-[10px] font-medium text-gray-400 uppercase tracking-wider">
            {(events[0] as any)?.source === 'ledger' ? 'Ledger' : 'Estimated'}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      )}

      {error && <p className="text-xs text-red-500">Failed to load history</p>}

      {events && events.length === 0 && !isLoading && (
        <p className="text-xs text-gray-400 py-4 text-center">No events recorded yet</p>
      )}

      {events && events.length > 0 && (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-3 bottom-3 w-px bg-gray-200" />

          <div className="space-y-4">
            {events.map((event: StreamEvent, idx: number) => {
              const cfg = eventConfig[event.type] ?? eventConfig['created']!;
              const Icon = cfg!.icon;
              const p = (event.payload ?? {}) as Record<string, string | number | undefined>;
              const ts =
                event.timestamp instanceof Date
                  ? event.timestamp
                  : new Date(event.timestamp as unknown as string);

              return (
                <div key={`${event.type}-${idx}`} className="relative flex items-start gap-3 pl-1">
                  <div
                    className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full ${cfg!.bg} flex-shrink-0`}
                  >
                    <Icon className={`h-3.5 w-3.5 ${cfg!.color}`} />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900">{cfg!.label}</span>
                      <span className="text-[10px] text-gray-400 tabular-nums flex-shrink-0">
                        {ts.toLocaleString()}
                      </span>
                    </div>
                    {/* Event details */}
                    {event.type === 'withdrawn' && p['amountWithdrawn'] && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Amount:{' '}
                        <span className="font-medium tabular-nums">
                          {String(p['amountWithdrawn'])}
                        </span>
                        {p['newTotalWithdrawn'] && (
                          <span className="text-gray-400">
                            {' '}
                            (total: {String(p['newTotalWithdrawn'])})
                          </span>
                        )}
                      </p>
                    )}
                    {event.type === 'cancelled' && (p['recipientAmount'] || p['senderRefund']) && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Recipient: {String(p['recipientAmount'] ?? '0')} / Refund:{' '}
                        {String(p['senderRefund'] ?? '0')}
                      </p>
                    )}
                    {event.type === 'renewed' && p['additionalDeposit'] && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Additional deposit:{' '}
                        <span className="font-medium tabular-nums">
                          {String(p['additionalDeposit'])}
                        </span>
                      </p>
                    )}
                    {event.type === 'created' && p['totalDeposited'] && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Deposited:{' '}
                        <span className="font-medium tabular-nums">
                          {String(p['totalDeposited'])}
                        </span>
                        {p['vestingMode'] && (
                          <span className="text-gray-400"> ({String(p['vestingMode'])})</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
