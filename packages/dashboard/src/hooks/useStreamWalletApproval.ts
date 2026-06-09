/**
 * @module hooks/useStreamWalletApproval
 *
 * React hook that wraps the wallet-mediated approval flow for an
 * incoming stream. Returns the current per-stream record + an
 * `approve()` callback that does the CIP-103 round-trip.
 *
 * The hook also listens for wallet transaction events and refreshes the
 * local record so manual and wallet-side changes stay in sync.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Stream } from '@canton-streams/sdk/browser';
import { walletClient } from '../store/wallet/index.js';
import {
  readStreamApproval,
  requestStreamWalletApproval,
  markStreamApproved,
  type StreamApprovalRecord,
} from '../lib/walletApprovals.js';

export interface UseStreamWalletApprovalResult {
  readonly record: StreamApprovalRecord;
  readonly isPending: boolean;
  readonly approve: () => Promise<void>;
  /** Manually confirm approval after the user finished signing in the wallet. */
  readonly markApproved: () => void;
}

export function useStreamWalletApproval(
  stream: Stream,
): UseStreamWalletApprovalResult {
  const [record, setRecord] = useState<StreamApprovalRecord>(() =>
    readStreamApproval(stream),
  );
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    let mounted = true;
    const listener = () => {
      if (!mounted) return;
      setRecord(readStreamApproval(stream));
    };
    walletClient.onTxChanged(listener).catch(() => {
      /* event subscription is best-effort; the manual mark button
       * remains as the deterministic confirmation path. */
    });
    return () => {
      mounted = false;
      walletClient.removeOnTxChanged(listener).catch(() => {});
    };
  }, [stream]);

  const approve = useCallback(async () => {
    setIsPending(true);
    try {
      const next = await requestStreamWalletApproval(stream);
      setRecord(next);
    } finally {
      setIsPending(false);
    }
  }, [stream]);

  const markApproved = useCallback(() => {
    const next = markStreamApproved(stream);
    setRecord(next);
  }, [stream]);

  return { record, isPending, approve, markApproved };
}
