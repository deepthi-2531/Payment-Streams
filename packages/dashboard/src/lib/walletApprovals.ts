/**
 * @module lib/walletApprovals
 *
 * Wallet-mediated stream acceptance, the CIP-103 way.
 *
 * Flow:
 *
 *   Bob opens the Streams Inbox
 *     → sees Alice's incoming CC stream
 *     → clicks "Approve in Amulet wallet"
 *     → the dashboard calls into `@canton-network/dapp-sdk`
 *     → the wallet renders the Amulet preapproval prompt
 *     → Bob signs in the wallet
 *     → the dashboard refreshes the stored approval state
 *
 * What this module IS today
 * -------------------------
 * - A real CIP-103 round-trip: clicking the button invokes
 *   `walletSdk.open()` so the Amulet wallet surface comes forward and
 *   the recipient completes the preapproval there.
 * - Per-stream approval-intent state, persisted in `sessionStorage` so
 *   the badge state survives reload and is scoped to the current
 *   session.
 * - A single `requestStreamWalletApproval` entry-point — the place a
 *   future contributor swaps in `walletSdk.prepareExecuteAndWait` with
 *   the real Amulet `TransferPreapproval` command, replacing the
 *   `walletSdk.open()` call. The on-screen status copy is already
 *   ready for that swap.
 *
 * What this module IS NOT today
 * -----------------------------
 * The dashboard does not (yet) construct the Amulet
 * `TransferPreapproval` Daml command from the dapp. That command lives
 * in `splice-amulet-*.dar`, which is not bundled in
 * `packages/daml/main/.lib/` — only the V2 token-standard interface
 * DARs (allocation / holding / transfer-instruction / transfer-events)
 * are. So we cannot yet pass `prepareExecuteAndWait` a
 * fully-qualified Daml command, and we cannot verify approval state
 * via `walletSdk.ledgerApi(...)` filtering on Amulet template ids.
 *
 * Tracking that work as a separate follow-up: pull the Amulet TS
 * binding into the asset registry, then swap the `walletSdk.open()`
 * call below for `walletSdk.prepareExecuteAndWait({ commands: [...] })`
 * and replace the `mark*` helpers with a real
 * `walletSdk.ledgerApi`-driven status query.
 */

import type { Stream } from '@canton-streams/sdk/browser';
import { walletSdk } from '../store/auth.js';

export type StreamApprovalStatus =
  | 'idle'
  | 'wallet-opened'
  | 'preapproved'
  | 'error';

export interface StreamApprovalRecord {
  readonly status: StreamApprovalStatus;
  /** ms epoch — when the user clicked, the wallet opened, or the swap completed. */
  readonly updatedAt: number;
  /** Optional human-readable error (only present when status === 'error'). */
  readonly errorMessage?: string;
}

const STORAGE_KEY = 'canton-streams-wallet-approvals';

/** Stable key for a stream — sender + streamId is the on-ledger
 * primary key shape used elsewhere in this code. */
export function streamApprovalKey(stream: Pick<Stream, 'config'>): string {
  return `${stream.config.sender}::${stream.config.streamId}`;
}

function readAll(): Record<string, StreamApprovalRecord> {
  if (typeof sessionStorage === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, StreamApprovalRecord>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(state: Record<string, StreamApprovalRecord>): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* sessionStorage may be unavailable (incognito etc.) */
  }
}

export function readStreamApproval(
  stream: Pick<Stream, 'config'>,
): StreamApprovalRecord {
  const all = readAll();
  return all[streamApprovalKey(stream)] ?? { status: 'idle', updatedAt: 0 };
}

function writeStreamApproval(
  stream: Pick<Stream, 'config'>,
  record: StreamApprovalRecord,
): void {
  const all = readAll();
  all[streamApprovalKey(stream)] = record;
  writeAll(all);
}

/**
 * Trigger the wallet-mediated approval flow for an incoming stream.
 *
 * Today this issues `walletSdk.open()` — a real CIP-103 call that
 * surfaces the connected Amulet wallet so the recipient can complete
 * the preapproval there. Once the Amulet TS binding is bundled, the
 * same function will issue
 * `walletSdk.prepareExecuteAndWait({ commands: [createTransferPreapproval(...)] })`
 * and the wallet will render the precise preapproval prompt directly.
 *
 * The function always updates the session-store record so the inbox
 * badge reflects what's actually happened, even if the wallet call
 * fails or the user dismisses the wallet.
 */
export async function requestStreamWalletApproval(
  stream: Stream,
): Promise<StreamApprovalRecord> {
  try {
    await walletSdk.open();
    const record: StreamApprovalRecord = {
      status: 'wallet-opened',
      updatedAt: Date.now(),
    };
    writeStreamApproval(stream, record);
    return record;
  } catch (err) {
    const record: StreamApprovalRecord = {
      status: 'error',
      updatedAt: Date.now(),
      errorMessage:
        err instanceof Error ? err.message : 'Wallet approval failed',
    };
    writeStreamApproval(stream, record);
    return record;
  }
}

/**
 * Mark a stream as preapproved once the recipient confirms the action
 * happened in the wallet. Manual button today; once
 * `walletSdk.ledgerApi(...)` returns a real Amulet `TransferPreapproval`
 * for this recipient + instrument, this helper will be called by the
 * background poller rather than the user.
 */
export function markStreamPreapproved(stream: Stream): StreamApprovalRecord {
  const record: StreamApprovalRecord = {
    status: 'preapproved',
    updatedAt: Date.now(),
  };
  writeStreamApproval(stream, record);
  return record;
}

/** Reset the local record for a stream (e.g. after a wallet-side revoke). */
export function clearStreamApproval(stream: Stream): void {
  const all = readAll();
  delete all[streamApprovalKey(stream)];
  writeAll(all);
}
