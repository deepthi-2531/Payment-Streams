/**
 * Executor status page.
 *
 * Hooks unchanged: `useQuery` for policies + execution logs with 10s
 * refetchInterval. Mock's `ops.jsx::ExecutorPage` layout: 4-stat hero +
 * recent-executions list.
 */

import { useQuery } from '@tanstack/react-query';
import { Shield, ScrollText, Activity, AlertCircle } from 'lucide-react';
import { useCantonClient } from '../hooks/useCantonClient.js';
import type { RawPolicy, RawExecutionLog } from '../api/client.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
  SectionHeader,
} from '../components/common/index.js';
import { PulseStat } from '../components/primitives/PulseStat.js';
import { formatCantonTimeOnly } from '../lib/cantonTime.js';

export function ExecutorStatusPage() {
  const client = useCantonClient();

  const policiesQ = useQuery({
    queryKey: ['policies'],
    queryFn: () => client?.listPolicies() ?? Promise.resolve([]),
    enabled: !!client,
    refetchInterval: 10_000,
  });

  const logsQ = useQuery({
    queryKey: ['execution-logs'],
    queryFn: () => client?.listExecutionLogs() ?? Promise.resolve([]),
    enabled: !!client,
    refetchInterval: 10_000,
  });

  if (!client) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader
          title="Executor Status"
          subtitle="Overview of the delegated execution service"
        />
        <div
          className="card"
          style={{ padding: 36, textAlign: 'center', color: 'var(--fg-3)' }}
        >
          Connect to a Canton participant to view executor status.
        </div>
      </div>
    );
  }

  const policies = policiesQ.data ?? [];
  const logs = logsQ.data ?? [];
  const activePolicies = policies.filter((p: RawPolicy) => p.active);
  const revokedPolicies = policies.filter((p: RawPolicy) => !p.active);
  const successfulLogs = logs.filter((l: RawExecutionLog) => l.success);
  const failedLogs = logs.filter((l: RawExecutionLog) => !l.success);
  const recentLogs = logs.slice(0, 10);
  const isPending = policiesQ.isPending || logsQ.isPending;
  const isError = policiesQ.isError || logsQ.isError;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Executor Status"
        subtitle="Overview of the delegated execution service"
      />

      {isError && (
        <ErrorState
          error={policiesQ.error ?? logsQ.error}
          title="Could not load executor status"
          onRetry={() => {
            void policiesQ.refetch();
            void logsQ.refetch();
          }}
        />
      )}

      {isPending && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}
        >
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
          <Skeleton.Card />
        </div>
      )}

      {!isPending && !isError && (
        <>
          {/* KPI stats */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              marginBottom: 24,
            }}
          >
            <PulseStat label="Active Policies" value={activePolicies.length} accent />
            <PulseStat label="Revoked Policies" value={revokedPolicies.length} />
            <PulseStat label="Successful Executions" value={successfulLogs.length} />
            <PulseStat label="Failed Executions" value={failedLogs.length} />
          </div>

          {/* Recent executions */}
          <SectionHeader title="Recent Executions" count={recentLogs.length} />
          {recentLogs.length === 0 ? (
            <div className="card" style={{ padding: 36, textAlign: 'center' }}>
              <ScrollText
                size={28}
                style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
              />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
                No executions recorded yet.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recentLogs.map((log: RawExecutionLog) => (
                <RecentLogCard key={log.contractId} log={log} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RecentLogCard({ log }: { readonly log: RawExecutionLog }) {
  const truncate = (s: string) =>
    s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderColor: log.success
          ? 'var(--line-2)'
          : 'color-mix(in oklab, var(--danger) 30%, transparent)',
        background: log.success
          ? 'var(--card)'
          : 'color-mix(in oklab, var(--danger) 5%, var(--card))',
      }}
    >
      {log.success ? (
        <Activity size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      ) : (
        <AlertCircle
          size={16}
          style={{ color: 'var(--danger)', flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 13,
          }}
        >
          <span className="mono" style={{ color: 'var(--fg-2)' }}>
            {truncate(log.targetStreamId)}
          </span>
          <span className="badge info" style={{ fontSize: 10 }}>
            {log.action}
          </span>
          <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 12 }}>
            {log.amount}
          </span>
        </div>
        {log.errorMessage && (
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 11.5,
              color: 'var(--danger)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {log.errorMessage}
          </p>
        )}
      </div>
      <span
        className="mono"
        style={{ fontSize: 11, color: 'var(--fg-4)', flexShrink: 0 }}
      >
        {formatCantonTimeOnly(log.executionTime)}
      </span>
    </div>
  );
}

// Re-export Shield to suppress unused warning (kept for parity with mock visual)
const _shield = Shield;
void _shield;
