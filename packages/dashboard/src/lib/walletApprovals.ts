/**
 * @module lib/walletApprovals
 *
 * Per-stream local confirmation state for receiver-side wallet approval.
 * The actual token-standard approval happens in the user's wallet; the
 * dashboard records that the user has started or manually confirmed that
 * wallet-side step.
 */

import type { Stream } from '@canton-streams/sdk/browser';
import { walletClient } from '../store/wallet/index.js';

export type StreamApprovalStatus =
  | 'idle'
  | 'confirmation-pending'
  | 'approved-local'
  | 'error';

export interface StreamApprovalRecord {
  readonly status: StreamApprovalStatus;
  /** ms epoch when the local approval record changed. */
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
  if (isLegacyWalletOpenedRecord(record)) {
    return {
      status: 'confirmation-pending',
      updatedAt: record.updatedAt,
      errorMessage: record.errorMessage,
    };
  }
  return isStreamApprovalRecord(record) ? record : { status: 'idle', updatedAt: 0 };
}

function isLegacyWalletOpenedRecord(
  record: unknown,
): record is { readonly updatedAt: number; readonly errorMessage?: string } {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { status?: unknown }).status === 'wallet-opened' &&
    typeof (record as { updatedAt?: unknown }).updatedAt === 'number'
  );
}

function isStreamApprovalRecord(record: unknown): record is StreamApprovalRecord {
  if (typeof record !== 'object' || record === null) return false;
  const status = (record as { status?: unknown }).status;
  return (
    status === 'idle' ||
    status === 'confirmation-pending' ||
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
 * Start the receiver-side approval step. Single-wallet flows can bring the
 * wallet UI forward; hosted wallet flows rely on the user's wallet surface.
 */
export async function requestStreamWalletApproval(
  stream: Stream,
): Promise<StreamApprovalRecord> {
  try {
    if (walletClient.capabilities.openSurfacesWalletUi) {
      await walletClient.open();
    }
    const record: StreamApprovalRecord = {
      status: 'confirmation-pending',
      updatedAt: Date.now(),
    };
    writeStreamApproval(stream, record);
    return record;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
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
 * Mark a stream as locally approved once the recipient confirms the wallet
 * approval happened.
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
