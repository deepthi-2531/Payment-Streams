/**
 * CancelDialog — two-mode stream cancellation component:
 *
 *   - `<CancelDialog sender streamId />` (button trigger form) — used in
 *     StreamDetail; clicks open the confirmation modal
 *   - `<CancelDialog sender streamId open onClose />` (controlled) — used
 *     when triggered from elsewhere (e.g. a parent context menu)
 *
 * Real `useCancel` mutation; danger-themed Modal with the standard
 * cc-streams warning aesthetic.
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, ErrorState } from '../common/index.js';
import { useCancel } from '../../hooks/useStreams.js';
import { Icons } from '../primitives/Icons.js';

interface CancelDialogProps {
  readonly sender: string;
  readonly streamId: string;
  /** Optional controlled open state; if omitted, renders own trigger button. */
  readonly open?: boolean;
  readonly onClose?: () => void;
}

export function CancelDialog({
  sender,
  streamId,
  open: controlledOpen,
  onClose: controlledOnClose,
}: CancelDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const cancelM = useCancel();
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const onClose =
    controlledOnClose ?? (() => setInternalOpen(false));

  const handleCancel = async () => {
    try {
      await cancelM.mutateAsync({ sender, streamId });
      onClose();
    } catch {
      // surfaced inline via ErrorState below
    }
  };

  return (
    <>
      {!isControlled && (
        <button
          type="button"
          onClick={() => setInternalOpen(true)}
          className="btn btn-danger"
        >
          <AlertTriangle size={14} />
          Cancel stream
        </button>
      )}

      <Modal
        open={open}
        onClose={cancelM.isPending ? () => {} : onClose}
        title="Cancel this stream?"
        subtitle={<span className="mono">{streamId}</span>}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={cancelM.isPending}
            >
              Keep streaming
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleCancel}
              disabled={cancelM.isPending}
            >
              {cancelM.isPending && <Icons.Spinner size={13} />}
              Confirm cancel
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'color-mix(in oklab, var(--danger) 18%, transparent)',
              color: 'var(--danger)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AlertTriangle size={18} />
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-2)' }}>
              Accrued tokens up to now are released to the recipient. The
              remaining undrawn balance is refunded to the sender.
            </p>
            <p
              style={{
                margin: '8px 0 0',
                fontSize: 12,
                color: 'var(--fg-4)',
              }}
            >
              This action is final — the stream cannot be re-activated.
            </p>
          </div>
        </div>

        {cancelM.isError && (
          <div style={{ marginTop: 16 }}>
            <ErrorState
              error={cancelM.error}
              title="Cancellation failed"
              onRetry={handleCancel}
            />
          </div>
        )}
      </Modal>
    </>
  );
}
