/**
 * WithdrawModal — confirm-and-withdraw for an active stream.
 *
 * Phase 6 (STR-122). Uses the real `useWithdraw` mutation. Surfaces the
 * current withdrawable balance so the user knows what they're claiming.
 * Server-side computes the actual amount based on accrual; this modal is
 * a confirmation step, not an amount selector.
 *
 * No mock data.
 */

import { useState } from 'react';
import { Modal, ErrorState } from '../common/index.js';
import { useWithdraw } from '../../hooks/useStreams.js';
import { Icons } from '../primitives/Icons.js';
import { MonoCounter } from '../primitives/MonoCounter.js';
import { getBalances } from '@canton-streams/sdk/browser';
import type { Stream } from '@canton-streams/sdk/browser';

export interface WithdrawModalProps {
  readonly stream: Stream;
  readonly onClose: () => void;
}

export function WithdrawModal({ stream, onClose }: WithdrawModalProps) {
  const withdrawM = useWithdraw();
  const [done, setDone] = useState(false);

  const balances = getBalances(stream);
  const withdrawableNum = Number(balances.withdrawable.toString());
  const asset = stream.config.instrumentRef?.instrumentId ?? '';

  const handleWithdraw = async () => {
    try {
      await withdrawM.mutateAsync({
        sender: stream.config.sender,
        streamId: stream.config.streamId,
      });
      setDone(true);
      setTimeout(onClose, 1100);
    } catch {
      // surfaced inline
    }
  };

  return (
    <Modal
      open
      onClose={withdrawM.isPending ? () => {} : onClose}
      title="Withdraw accrued balance"
      subtitle={<span className="mono">{stream.config.streamId}</span>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={withdrawM.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleWithdraw}
            disabled={withdrawM.isPending || done || withdrawableNum <= 0}
          >
            {withdrawM.isPending && <Icons.Spinner size={13} />}
            {done ? 'Withdrawn' : 'Withdraw'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            Available to withdraw now
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <MonoCounter value={withdrawableNum} size={32} accent decimals={4} />
            {asset && (
              <span className="mono" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {asset}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-4)', marginTop: 10 }}>
            Accrued: <span className="mono" style={{ color: 'var(--fg-2)' }}>
              {balances.accrued.toString()}
            </span>{' '}
            · Already withdrawn:{' '}
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              {balances.alreadyWithdrawn.toString()}
            </span>
          </div>
        </div>

        {withdrawableNum <= 0 && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--warn-soft)',
              border: '1px solid color-mix(in oklab, var(--warn) 30%, transparent)',
              fontSize: 12.5,
              color: 'var(--fg-2)',
            }}
          >
            Nothing to withdraw right now. The ledger will reject an empty withdrawal.
          </div>
        )}

        <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)' }}>
          The exact amount transferred is computed on-chain at submission time
          based on the live accrual; the value above is a client-side estimate.
        </p>

        {withdrawM.isError && (
          <ErrorState
            error={withdrawM.error}
            title="Withdrawal failed"
            onRetry={handleWithdraw}
          />
        )}
      </div>
    </Modal>
  );
}
