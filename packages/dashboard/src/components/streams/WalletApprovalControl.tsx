/**
 * @module components/streams/WalletApprovalControl
 *
 * Inline control rendered on each incoming-stream card. Drives the
 * wallet-mediated approval flow:
 *
 *   1. Status pill: idle / wallet-opened / approved-local / error.
 *   2. Primary button:
 *      - idle      → "Approve in Amulet wallet"  (triggers wallet round-trip)
 *      - wallet-opened → "Mark approved"         (confirm once Bob approved in Amulet)
 *      - approved-local → small "Reset" link only
 *      - error     → "Try again"                 (retry the round-trip)
 *   3. Error inline message when the wallet call failed.
 *
 * The actual CIP-103 call and per-stream state machine live in
 * `lib/walletApprovals.ts` + `hooks/useStreamWalletApproval.ts`.
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
  // We need a connected wallet for `walletClient.open()` to land
  // — wallet adapters throw "Not connected — call connect() first"
  // otherwise. Surface that as an inline, actionable hint instead of
  // letting the raw error bubble out of the click handler. A
  // dev-mode session (JWT-paste path) has no wallet to round-trip
  // through, so the button stays disabled there too.
  const { isAuthenticated, devMode } = useAuth();
  const cannotApprove = !isAuthenticated || devMode;

  if (cannotApprove && record.status === 'idle') {
    return (
      <div style={containerStyle}>
        <StatusPill status="no-wallet" />
        <span style={hintTextStyle}>
          Connect a CIP-103 wallet (top-right) to approve this stream in Amulet.
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
          {isPending ? 'Opening wallet…' : 'Approve in Amulet wallet'}
        </button>
      )}

      {record.status === 'wallet-opened' && (
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
            <Wallet size={12} /> Reopen wallet
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
  | 'wallet-opened'
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
      'No CIP-103 wallet is connected to this session. Connect a wallet (top-right) before you can approve streams in Amulet. The dev-mode JWT path does not have a wallet to round-trip through.',
    icon: Plug,
    bg: 'var(--bg-elev)',
    fg: 'var(--fg-3)',
  },
  idle: {
    label: 'No wallet approval yet',
    help:
      'You have not opened the Amulet wallet for this stream. Click "Approve in Amulet wallet" to start the CIP-103 wallet approval flow.',
    icon: Wallet,
    bg: 'var(--bg-elev)',
    fg: 'var(--fg-3)',
  },
  'wallet-opened': {
    label: 'Wallet open — sign there',
    help:
      'The Amulet wallet has been surfaced via CIP-103. Complete the AllocationRequest approval in the wallet, then click "Mark approved" to record it locally.',
    icon: Wallet,
    bg: 'var(--warn-soft)',
    fg: 'var(--warn)',
  },
  'approved-local': {
    label: 'Approved (local record)',
    help:
      'You confirmed the wallet approval. The Amulet AllocationRequest approval lives in the wallet; the dashboard records only the local confirmation here.',
    icon: CheckCircle2,
    bg: 'var(--accent-soft)',
    fg: 'var(--accent)',
  },
  error: {
    label: 'Approval failed',
    help: 'The CIP-103 call to the wallet failed. See the error message; try again or check the wallet gateway.',
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
