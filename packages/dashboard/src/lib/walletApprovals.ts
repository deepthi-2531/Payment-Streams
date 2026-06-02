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
 *     → the wallet renders the Amulet acceptance prompt
 *     → Bob signs in the wallet
 *     → the dashboard refreshes the stored approval state
 *
 * What this module IS today
 * -------------------------
 * - A real CIP-103 round-trip: clicking the button invokes
 *   `walletSdk.open()` so the Amulet wallet surface comes forward and
 *   the recipient completes the acceptance there.
 * - Per-stream approval-intent state, persisted in `sessionStorage` so
 *   the badge state survives reload and is scoped to the current
 *   session.
 * - A single `requestStreamWalletApproval` entry-point — the place a
 *   future contributor swaps in `walletSdk.prepareExecuteAndWait` with
 *   the real V2 `AllocationRequest_Accept` (committed-iterated)
 *   command, replacing the `walletSdk.open()` call. The on-screen
 *   status copy is already ready for that swap.
 *
 * What this module IS NOT today
 * -----------------------------
 * The dashboard does not yet *construct* the recipient-side accept
 * command for the V2 AllocationRequest. The required interface DARs
 * are already in `packages/daml/main/.lib/`
 * (`splice-api-token-allocation-v2`,
 * `splice-api-token-allocation-request-v2`,
 * `splice-api-token-allocation-instruction-v2`), and the Amulet wallet
 * that ships on every validator node supports CIP-56 V2 on the
 * `token-standard-v2-upcoming` branch we pin against. So the
 * impediment is implementation, not missing bindings: someone needs
 * to wire the AllocationRequest contract id + the accept choice
 * payload through to `walletSdk.prepareExecuteAndWait(...)`. Upstream
 * support for iterated settlement in the Amulet wallet UX is tracked
 * in canton-network/splice#5498 — read it before committing to a
 * specific shape.
 *
 * Until that swap lands the button still does the right CIP-103
 * thing: it brings the wallet forward via `walletSdk.open()`, the
 * recipient completes the acceptance in the wallet's own UI, and the
 * dashboard records the local intent so the inbox badge stays
 * truthful across reloads.
 *
 * Upstream wallet target for the future swap: the Amulet wallet UI
 * that creates + accepts committed V2 allocations with
 * `nextIterationFunding` lives on canton-network/splice#5697
 * (branch `oriol/initialted-settlement-fe`, head sha
 * `73c68d16ba93346a80418662f94a7877e3938f91`). That sha is exported
 * from `scripts/fetch-v2-dars.mjs` as `SPLICE_PR5697_PREVIEW_COMMIT`;
 * `scripts/start-localnet-e2e.sh` recognises it. The E2E harness
 * runbook `docs/E2E-HARNESS.md` documents the opt-in path. A
 * contributor wiring `walletSdk.prepareExecuteAndWait(...)` should
 * develop against a LocalNet built from that commit (or its
 * successor merge sha) so the wallet renders the right shape.
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
    const raw = err instanceof Error ? err.message : String(err);
    // The dapp-sdk throws "Not connected — call connect() first" when
    // `walletSdk.open()` is fired before a wallet session exists.
    // Translate that into actionable copy for the inbox card rather
    // than passing the bare SDK string straight to the user.
    const actionable = /not connected/i.test(raw)
      ? 'No CIP-103 wallet is connected to this session. Connect a wallet (top-right) and try again.'
      : raw;
    const record: StreamApprovalRecord = {
      status: 'error',
      updatedAt: Date.now(),
      errorMessage: actionable,
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
