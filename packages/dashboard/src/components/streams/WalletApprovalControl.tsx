/**
 * @module components/streams/WalletApprovalControl
 *
 * Inline control for receiver-side wallet approval of incoming streams.
 */

import type { CSSProperties } from 'react';
import { CheckCircle2, AlertCircle, Wallet, RotateCcw, Plug } from 'lucide-react';
import type { Stream } from '@canton-streams/sdk/browser';
import { useStreamWalletApproval } from '../../hooks/useStreamWalletApproval.js';
import { clearStreamApproval } from '../../lib/walletApprovals.js';
import { useAuth } from '../../store/auth.js';

export interface WalletApprovalControlProps {
  readonly stream: Stream;
}

export function WalletApprovalControl({ stream }: WalletApprovalControlProps) {
  const { record, isPending, approve, markApproved } = useStreamWalletApproval(stream);
  const { isAuthenticated, devMode } = useAuth();
  const cannotApprove = !isAuthenticated || devMode;

  if (cannotApprove && record.status === 'idle') {
    return (
      <div style={containerStyle}>
        <StatusPill status="no-wallet" />
        <span style={hintTextStyle}>
          Connect a CIP-103 wallet to approve this stream.
        </span>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <StatusPill status={record.status} />

      {record.status === 'idle' && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void approve()}
          disabled={isPending || cannotApprove}
        >
          <Wallet size={12} />
          {isPending ? 'Starting approval…' : 'Start wallet approval'}
        </button>
      )}

      {record.status === 'confirmation-pending' && (
        <>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={markApproved}
          >
            <CheckCircle2 size={12} /> Mark approved
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void approve()}
            disabled={isPending}
            title="Reopen the wallet"
          >
            <Wallet size={12} /> Restart
          </button>
        </>
      )}

      {record.status === 'approved-local' && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            clearStreamApproval(stream);
            // Force a remount by re-clicking approve so state syncs.
            void approve();
          }}
          title="Clear local approval record"
        >
          <RotateCcw size={11} /> Reset
        </button>
      )}

      {record.status === 'error' && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void approve()}
          disabled={isPending}
        >
          <Wallet size={12} /> Try again
        </button>
      )}

      {record.status === 'error' && record.errorMessage && (
        <span style={errorTextStyle}>{record.errorMessage}</span>
      )}
    </div>
  );
}

function StatusPill({ status }: { readonly status: StatusValue }) {
  const cfg = STATUS[status];
  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10.5,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 999,
        background: cfg.bg,
        color: cfg.fg,
      }}
      title={cfg.help}
    >
      <cfg.icon size={10} />
      {cfg.label}
    </span>
  );
}

type StatusValue =
  | 'idle'
  | 'confirmation-pending'
  | 'approved-local'
  | 'error'
  | 'no-wallet';

const STATUS: Record<
  StatusValue,
  { label: string; help: string; icon: typeof Wallet; bg: string; fg: string }
> = {
  'no-wallet': {
    label: 'Wallet not connected',
    help:
      'Connect a wallet before approving incoming streams. Dev-mode sessions cannot complete wallet approval.',
    icon: Plug,
    bg: 'var(--bg-elev)',
    fg: 'var(--fg-3)',
  },
  idle: {
    label: 'No wallet approval yet',
    help:
      'Start the wallet approval flow, complete the approval in your wallet, then mark it approved here.',
    icon: Wallet,
    bg: 'var(--bg-elev)',
    fg: 'var(--fg-3)',
  },
  'confirmation-pending': {
    label: 'Confirm in wallet',
    help:
      'Complete the approval in your wallet, then click "Mark approved" to record the local confirmation.',
    icon: Wallet,
    bg: 'var(--warn-soft)',
    fg: 'var(--warn)',
  },
  'approved-local': {
    label: 'Approved (local record)',
    help:
      'You confirmed the wallet approval. The dashboard stores this as a local confirmation.',
    icon: CheckCircle2,
    bg: 'var(--accent-soft)',
    fg: 'var(--accent)',
  },
  error: {
    label: 'Approval failed',
    help: 'The wallet approval step failed. See the error message, then try again.',
    icon: AlertCircle,
    bg: 'var(--danger-soft)',
    fg: 'var(--danger)',
  },
};

const containerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const errorTextStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--danger)',
};

const hintTextStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--fg-3)',
};
