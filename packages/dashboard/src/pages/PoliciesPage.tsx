/**
 * PoliciesPage — STR-121 Phase 5 reskin to cc-streams aesthetic.
 *
 * Same TanStack hooks (`useQuery({ queryKey: ['policies'] })` +
 * `useMutation` for revoke) — purely visual reskin from the mock's
 * `ops.jsx::PoliciesPage` layout. No mock data.
 */

import { useState, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, ShieldOff } from 'lucide-react';
import { useCantonClient } from '../hooks/useCantonClient.js';
import type { RawPolicy } from '../api/client.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';
import { Icons } from '../components/primitives/Icons.js';
import { Copyable } from '../components/primitives/Copyable.js';
import { formatCantonDate } from '../lib/cantonTime.js';

export function PoliciesPage() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<string | null>(null);

  const policiesQ = useQuery({
    queryKey: ['policies'],
    queryFn: () => client?.listPolicies() ?? Promise.resolve([]),
    enabled: !!client,
  });

  const revokeMutation = useMutation({
    mutationFn: async (contractId: string) => {
      setRevoking(contractId);
      return client?.revokePolicy(contractId);
    },
    onSettled: () => {
      setRevoking(null);
      queryClient.invalidateQueries({ queryKey: ['policies'] });
    },
  });

  if (!client) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader
          title="Delegated Policies"
          subtitle="Manage executor delegation policies for automated stream operations"
        />
        <div
          className="card"
          style={{ padding: 36, textAlign: 'center', color: 'var(--fg-3)' }}
        >
          Connect to a Canton participant to view policies.
        </div>
      </div>
    );
  }

  const policies = policiesQ.data;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Delegated Policies"
        subtitle="Manage executor delegation policies for automated stream operations"
      />

      {policiesQ.isPending && <Skeleton.Row count={4} height={56} />}

      {policiesQ.isError && (
        <ErrorState
          error={policiesQ.error}
          title="Could not load policies"
          onRetry={() => policiesQ.refetch()}
        />
      )}

      {policies && policies.length === 0 && !policiesQ.isPending && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <Shield
            size={28}
            style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }}
          />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
            No delegated policies found.
          </p>
        </div>
      )}

      {policies && policies.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Policy ID</th>
                <th>Sender</th>
                <th>Recipient</th>
                <th>Executor</th>
                <th>Actions</th>
                <th>Status</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policies.map((policy: RawPolicy) => (
                <PolicyRow
                  key={policy.contractId}
                  policy={policy}
                  revoking={revoking === policy.contractId}
                  onRevoke={() => revokeMutation.mutate(policy.contractId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PolicyRow({
  policy,
  revoking,
  onRevoke,
}: {
  readonly policy: RawPolicy;
  readonly revoking: boolean;
  readonly onRevoke: () => void;
}) {
  return (
    <tr>
      <td>
        <Copyable
          value={policy.policyId}
          display={
            policy.policyId.length > 18
              ? `${policy.policyId.slice(0, 10)}…${policy.policyId.slice(-6)}`
              : policy.policyId
          }
        />
      </td>
      <td>
        <Copyable
          value={policy.sender}
          display={shortenParty(policy.sender)}
        />
      </td>
      <td>
        <Copyable
          value={policy.recipient}
          display={shortenParty(policy.recipient)}
        />
      </td>
      <td>
        <Copyable
          value={policy.executor}
          display={shortenParty(policy.executor)}
        />
      </td>
      <td>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {policy.allowedActions.map((a) => (
            <span key={a} className="badge info" style={{ fontSize: 10 }}>
              {a}
            </span>
          ))}
        </div>
      </td>
      <td>
        {policy.active ? (
          <span className="badge accent" style={{ paddingLeft: 6 }}>
            <Shield size={11} /> Active
          </span>
        ) : (
          <span className="badge muted">
            <ShieldOff size={11} /> Revoked
          </span>
        )}
      </td>
      <td
        className="mono"
        style={{ fontSize: 12, color: 'var(--fg-3)' }}
      >
        {formatCantonDate(policy.expiresAt)}
      </td>
      <td>
        {policy.active && (
          <button
            onClick={onRevoke}
            disabled={revoking}
            className="btn btn-danger btn-sm"
          >
            {revoking ? (
              <Icons.Spinner size={11} />
            ) : (
              <ShieldOff size={11} />
            )}
            Revoke
          </button>
        )}
      </td>
    </tr>
  );
}

function shortenParty(party: string): string {
  if (party.length <= 18) return party;
  const sep = party.indexOf('::');
  if (sep < 0) return party.slice(0, 10) + '…' + party.slice(-6);
  return party.slice(0, sep) + '::' + party.slice(sep + 2, sep + 8) + '…';
}

// Suppress unused warning for CSSProperties — kept in case future tweaks need it.
const _unused: CSSProperties = {};
void _unused;
