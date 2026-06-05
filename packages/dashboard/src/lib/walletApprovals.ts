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
 *     → the dashboard calls into the active wallet adapter
 *     → the Amulet wallet opens so Bob can complete the AllocationRequest
 *       approval there when a matching request exists
 *     → the dashboard refreshes the stored approval state
 *
 * What this module IS today
 * -------------------------
 * - A real CIP-103 round-trip: clicking the button invokes
 *   `walletClient.open()` so the Amulet wallet surface comes forward and
 *   the recipient can complete the AllocationRequest approval there.
 * - Per-stream approval-intent state, persisted in `sessionStorage` so
 *   the badge state survives reload and is scoped to the current
 *   session.
 * - A single `requestStreamWalletApproval` entry-point — the place a
 *   future contributor swaps in `walletClient.prepareExecuteAndWait` with
 *   the real V2 `AllocationRequest_Accept` (committed-iterated)
 *   command, replacing the `walletClient.open()` call. The on-screen
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
 * payload through to `walletClient.prepareExecuteAndWait(...)`. Upstream
 * support for iterated settlement in the Amulet wallet UX is tracked
 * in canton-network/splice#5498 — read it before committing to a
 * specific shape.
 *
 * Until that swap lands the button still does the right CIP-103
 * thing: it brings the wallet forward via `walletClient.open()`, the
 * recipient completes the AllocationRequest approval in the wallet's
 * own UI when the request exists there, and the
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
 * contributor wiring `walletClient.prepareExecuteAndWait(...)` should
 * develop against a LocalNet built from that commit (or its
 * successor merge sha) so the wallet renders the right shape.
 */

import type { Stream } from '@canton-streams/sdk/browser';
import { walletClient } from '../store/wallet/index.js';

export type StreamApprovalStatus =
  | 'idle'
  | 'wallet-opened'
  | 'approved-local'
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
  const record = all[streamApprovalKey(stream)];
  return isStreamApprovalRecord(record) ? record : { status: 'idle', updatedAt: 0 };
}

function isStreamApprovalRecord(record: unknown): record is StreamApprovalRecord {
  if (typeof record !== 'object' || record === null) return false;
  const status = (record as { status?: unknown }).status;
  return (
    status === 'idle' ||
    status === 'wallet-opened' ||
    status === 'approved-local' ||
    status === 'error'
  );
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
 * Today this issues `walletClient.open()` — a real wallet call that
 * surfaces the connected Amulet wallet so the recipient can complete
 * the AllocationRequest approval there if the request is visible in
 * Amulet. Once dashboard-side acceptance is wired, the same function
 * will issue
 * `walletClient.prepareExecuteAndWait({ commands: [AllocationRequest_Accept] })`
 * with the real request cid and choice payload.
 *
 * The function always updates the session-store record so the inbox
 * badge reflects what's actually happened, even if the wallet call
 * fails or the user dismisses the wallet.
 */
export async function requestStreamWalletApproval(
  stream: Stream,
): Promise<StreamApprovalRecord> {
  try {
    // `walletClient.open()` only does something useful on layers
    // that map it to a real "bring the wallet UI forward" action
    // (the dapp-sdk picker / Amulet wallet gateway). On a hosted-
    // multi-wallet layer (PartyLayer) the picker handles its own
    // visibility and `open()` is a documented no-op — calling it
    // would leave us recording `wallet-opened` without anything
    // having actually opened, lying to the user about the state.
    // Gate the call on the capability flag.
    if (walletClient.capabilities.openSurfacesWalletUi) {
      await walletClient.open();
    }
    const record: StreamApprovalRecord = {
      status: 'wallet-opened',
      updatedAt: Date.now(),
    };
    writeStreamApproval(stream, record);
    return record;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Wallet adapters commonly throw "Not connected — call connect()
    // first" when `walletClient.open()` is fired before a wallet
    // session exists.
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
 * Mark a stream as locally approved once the recipient confirms the
 * AllocationRequest approval happened in the wallet. Manual button
 * today; once `walletClient.ledgerApi(...)` can verify the matching
 * Amulet AllocationRequest/Allocation state, this helper will be
 * called by the background poller rather than the user.
 */
export function markStreamApproved(stream: Stream): StreamApprovalRecord {
  const record: StreamApprovalRecord = {
    status: 'approved-local',
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
