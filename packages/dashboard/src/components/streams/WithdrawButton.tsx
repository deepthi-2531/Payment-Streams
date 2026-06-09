/**
 * WithdrawButton — opens the cc-streams WithdrawModal for confirmation
 * before submitting the real `useWithdraw` mutation.
 *
 * This avoids one-click ledger writes and gives users a review step.
 */

import { useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { WithdrawModal } from './WithdrawModal.js';
import type { Stream } from '@canton-streams/sdk/browser';

interface WithdrawButtonProps {
  readonly stream: Stream;
}

export function WithdrawButton({ stream }: WithdrawButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
      >
        <ArrowDownToLine size={14} />
        Withdraw
      </button>
      {open && <WithdrawModal stream={stream} onClose={() => setOpen(false)} />}
    </>
  );
}
