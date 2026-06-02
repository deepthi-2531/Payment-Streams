/**
 * @module hooks/useStreamWalletApproval
 *
 * React hook that wraps the wallet-mediated approval flow for an
 * incoming stream. Returns the current per-stream record + an
 * `approve()` callback that does the CIP-103 round-trip.
 *
 * The hook subscribes to `walletSdk.onTxChanged` so that when the
 * wallet broadcasts a tx-executed event (the user finished signing
 * something in the wallet), the inbox immediately re-reads the local
 * record. Once the dashboard has the Amulet TS binding, the same
 * subscription point will trigger a fresh `walletSdk.ledgerApi` query
 * to verify the preapproval landed on-ledger.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Stream } from '@canton-streams/sdk/browser';
import { walletSdk } from '../store/auth.js';
import {
  readStreamApproval,
  requestStreamWalletApproval,
  markStreamPreapproved,
  type StreamApprovalRecord,
} from '../lib/walletApprovals.js';

export interface UseStreamWalletApprovalResult {
  readonly record: StreamApprovalRecord;
  readonly isPending: boolean;
  readonly approve: () => Promise<void>;
  /** Manually confirm preapproval after the user finished signing in the wallet. */
  readonly markPreapproved: () => void;
}

export function useStreamWalletApproval(
  stream: Stream,
): UseStreamWalletApprovalResult {
  const [record, setRecord] = useState<StreamApprovalRecord>(() =>
    readStreamApproval(stream),
  );
  const [isPending, setIsPending] = useState(false);

  // Re-read on wallet tx-changed events. The wallet broadcasts these
  // when ANY tx the user signed in the wallet is observed; we use it as
  // a cheap "the user did something" trigger. Once
  // `walletSdk.ledgerApi(...)` is wired to query Amulet preapprovals,
  // this callback also kicks off that fetch.
  useEffect(() => {
    let mounted = true;
    const listener = () => {
      if (!mounted) return;
      setRecord(readStreamApproval(stream));
    };
    walletSdk.onTxChanged(listener).catch(() => {
      /* event subscription is best-effort; the manual mark button
       * remains as the deterministic confirmation path. */
    });
    return () => {
      mounted = false;
      walletSdk.removeOnTxChanged(listener).catch(() => {});
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

  const markPreapproved = useCallback(() => {
    const next = markStreamPreapproved(stream);
    setRecord(next);
  }, [stream]);

  return { record, isPending, approve, markPreapproved };
}
