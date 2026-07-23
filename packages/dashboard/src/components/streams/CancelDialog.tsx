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

/**
 * Turn a raw proxy/ledger error into something a person can read — chiefly by
 * stripping party ids and rewording the "wrong party" case, which is the one
 * users actually hit. Only the sender can stop a stream; anyone else gets that.
 */
function friendlyCancelError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (/requires the sender party|sender party/i.test(raw)) {
    return new Error(
      "Only the person who set up this stream can stop it. You're the recipient here.",
    );
  }
  // Drop any bare party id (localname::<hex fingerprint>) so hashes never surface.
  const cleaned = raw.replace(/\b[\w-]+::[0-9a-f]{6,}\b/gi, 'the wallet').trim();
  return new Error(cleaned || 'Something went wrong. Please try again.');
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
        title="Stop this stream?"
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
              Anything paid so far stays with the recipient. Whatever hasn't been
              paid out comes straight back to you.
            </p>
            <p
              style={{
                margin: '8px 0 0',
                fontSize: 12,
                color: 'var(--fg-4)',
              }}
            >
              This can't be undone — the stream won't restart.
            </p>
          </div>
        </div>

        {cancelM.isError && (
          <div style={{ marginTop: 16 }}>
            <ErrorState
              error={friendlyCancelError(cancelM.error)}
              title="Couldn't stop the stream"
              onRetry={handleCancel}
            />
          </div>
        )}
      </Modal>
    </>
  );
}
