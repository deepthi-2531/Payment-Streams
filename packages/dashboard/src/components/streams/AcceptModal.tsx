/**
 * AcceptModal — review + accept a pending incoming stream request.
 *
 * Phase 6 (STR-122). Uses the real `useAcceptStream` mutation from
 * `hooks/useStreams.ts`. Shows the sender + total + vesting + settlement
 * up front so the user can verify before signing. No mock data.
 */

import { useState } from 'react';
import { Modal, ErrorState } from '../common/index.js';
import { useAcceptStream } from '../../hooks/useStreams.js';
import { PartyChip } from '../primitives/PartyChip.js';
import { VestingBadge } from '../primitives/VestingBadge.js';
import { SettlementBadge } from '../primitives/SettlementBadge.js';
import { MonoCounter } from '../primitives/MonoCounter.js';
import { Icons } from '../primitives/Icons.js';
import type { PendingStreamRequest } from '@canton-streams/sdk/browser';

export interface AcceptModalProps {
  readonly request: PendingStreamRequest;
  readonly onClose: () => void;
}

export function AcceptModal({ request, onClose }: AcceptModalProps) {
  const acceptM = useAcceptStream();
  const [done, setDone] = useState(false);

  const handleAccept = async () => {
    try {
      await acceptM.mutateAsync({
        sender: request.config.sender,
        streamId: request.config.streamId,
      });
      setDone(true);
      // Give the user a beat to see the success state, then close.
      setTimeout(onClose, 1100);
    } catch {
      // Error surfaced inline via mutation state; no need to swallow.
    }
  };

  const totalNum = Number(request.config.totalDeposited.toString());
  const asset = request.config.instrumentRef?.instrumentId ?? '';

  return (
    <Modal
      open
      onClose={acceptM.isPending ? () => {} : onClose}
      title="Accept stream request"
      subtitle={
        <span className="mono">{request.config.streamId}</span>
      }
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={acceptM.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAccept}
            disabled={acceptM.isPending || done}
          >
            {acceptM.isPending && <Icons.Spinner size={13} />}
            {done ? 'Accepted' : 'Accept request'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* From */}
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: 'var(--fg-4)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 8,
            }}
          >
            From
          </div>
          <PartyChip
            identity={{
              handle: request.config.sender.split('::')[0],
              party: request.config.sender,
            }}
            size="lg"
          />
        </div>

        {/* Amount */}
        <div className="card" style={{ padding: 18 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: 'var(--fg-4)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 8,
            }}
          >
            Total streamed
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <MonoCounter value={totalNum} size={28} accent />
            {asset && (
              <span className="mono" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {asset}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-3)',
              marginTop: 8,
            }}
          >
            {request.config.startTime.toLocaleDateString()} →{' '}
            {request.config.endTime.toLocaleDateString()}
          </div>
        </div>

        {/* Schedule + Settlement */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <VestingBadge vesting={request.config.vestingMode.mode} />
          {request.settlementMode && (
            <SettlementBadge mode={request.settlementMode} />
          )}
          {request.config.cancellable && (
            <span className="badge muted">Cancellable</span>
          )}
        </div>

        {acceptM.isError && (
          <ErrorState
            error={acceptM.error}
            title="Could not accept request"
            onRetry={handleAccept}
          />
        )}
      </div>
    </Modal>
  );
}
