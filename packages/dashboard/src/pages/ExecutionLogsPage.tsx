/**
 * Execution logs page.
 *
 * Hooks unchanged: `useQuery(['execution-logs', policyFilter])` against
 * `client.listExecutionLogs(policyFilter?)`. Layout from mock's
 * `ops.jsx::LogsPage` — filter input + audit table.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, CheckCircle2, XCircle, Search } from 'lucide-react';
import { useCantonClient } from '../hooks/useCantonClient.js';
import type { RawExecutionLog } from '../api/client.js';
import { formatCantonDateTime } from '../lib/cantonTime.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';

export function ExecutionLogsPage() {
  const client = useCantonClient();
  const [policyFilter, setPolicyFilter] = useState('');

  const logsQ = useQuery({
    queryKey: ['execution-logs', policyFilter],
    queryFn: () =>
      client?.listExecutionLogs(policyFilter || undefined) ?? Promise.resolve([]),
    enabled: !!client,
  });

  if (!client) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader
          title="Execution Logs"
          subtitle="Audit trail of delegated policy executions"
        />
        <div
          className="card"
          style={{ padding: 36, textAlign: 'center', color: 'var(--fg-3)' }}
        >
          Connect to a Canton participant to view execution logs.
        </div>
      </div>
    );
  }

  const logs = logsQ.data;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Execution Logs"
        subtitle="Audit trail of delegated policy executions"
      />

      {/* Filter bar */}
      <div style={{ marginBottom: 18, display: 'flex' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--bg-elev)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-md)',
            padding: '6px 10px',
            width: 320,
          }}
        >
          <Search size={13} style={{ color: 'var(--fg-4)' }} />
          <input
            type="text"
            placeholder="Filter by policy ID…"
            value={policyFilter}
            onChange={(e) => setPolicyFilter(e.target.value)}
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

      {logsQ.isError && (
        <ErrorState
          error={logsQ.error}
          title="Could not load execution logs"
          onRetry={() => logsQ.refetch()}
        />
      )}

      {logsQ.isPending && <Skeleton.Row count={6} height={48} />}

      {logs && logs.length === 0 && !logsQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <ScrollText
            size={28}
            style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
          />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
            No execution logs found.
          </p>
        </div>
      )}

      {logs && logs.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Policy</th>
                <th>Stream</th>
                <th>Action</th>
                <th>Amount</th>
                <th>Time</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log: RawExecutionLog) => (
                <LogRow key={log.contractId} log={log} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogRow({ log }: { readonly log: RawExecutionLog }) {
  const truncate = (s: string) =>
    s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;

  return (
    <tr>
      <td>
        {log.success ? (
          <CheckCircle2 size={14} style={{ color: 'var(--accent)' }} />
        ) : (
          <XCircle size={14} style={{ color: 'var(--danger)' }} />
        )}
      </td>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {truncate(log.policyId)}
      </td>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {truncate(log.targetStreamId)}
      </td>
      <td>
        <span className="badge info" style={{ fontSize: 10 }}>
          {log.action}
        </span>
      </td>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {log.amount}
      </td>
      <td
        className="mono"
        style={{ fontSize: 11.5, color: 'var(--fg-3)' }}
      >
        {formatCantonDateTime(log.executionTime)}
      </td>
      <td
        style={{
          fontSize: 11.5,
          color: 'var(--danger)',
          maxWidth: 280,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {log.errorMessage ?? '—'}
      </td>
    </tr>
  );
}
