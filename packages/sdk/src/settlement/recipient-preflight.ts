/**
 * @module settlement/recipient-preflight
 *
 * Recipient deliverability pre-flight for streams paying EXTERNAL
 * parties (recipients hosted on other organizations' participants).
 *
 * Asks the token-standard registry (Scan for Amulet) how a transfer to
 * the recipient would settle, WITHOUT submitting anything on-ledger:
 * the transfer-factory endpoint is a read-only context computation.
 *
 *   - `direct`  → recipient holds a `TransferPreapproval`: every stream
 *                 cycle delivers in one step, no recipient signature.
 *   - `offer`   → no preapproval: each cycle creates a two-step transfer
 *                 offer the recipient must accept (works, but degraded
 *                 UX) — surface "ask the recipient to enable a
 *                 TransferPreapproval" before activating the stream.
 *   - `self`    → sender == receiver (probe/test topology).
 *
 * Field-validated on Canton MainNet 2026-06-10 (see
 * docs/reports/mainnet-external-stream-2026-06-10.md).
 *
 * Browser-safe: uses `fetch`, no Node-only dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransferKind = 'direct' | 'offer' | 'self' | 'unknown';

export interface RecipientPreflightParams {
  /** Token-standard registry API base (bare Scan host for Amulet). */
  readonly registryApiUrl: string;
  /** Instrument admin (DSO party for CC). */
  readonly expectedAdmin: string;
  /** Paying party. */
  readonly sender: string;
  /** Recipient party to check. */
  readonly receiver: string;
  /** Instrument id (default Amulet/CC). */
  readonly instrumentId?: string;
  /**
   * Probe amount used only for context computation — nothing is
   * submitted. Defaults to "1.0".
   */
  readonly amount?: string;
  /** Optional bearer token for the registry API. */
  readonly token?: string;
}

export interface RecipientPreflightResult {
  /** True when streams can deliver hands-free (kind === 'direct'). */
  readonly deliverable: boolean;
  /** Registry-reported transfer kind. */
  readonly transferKind: TransferKind;
  /**
   * Human guidance matching the result — suitable for surfacing
   * directly in an operator UI.
   */
  readonly guidance: string;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/**
 * Check whether streaming to `receiver` will deliver hands-free.
 *
 * Never submits a command; only calls the registry's transfer-factory
 * context endpoint.
 */
export async function checkRecipientDeliverability(
  params: RecipientPreflightParams,
): Promise<RecipientPreflightResult> {
  const base = params.registryApiUrl.replace(/\/$/, '');
  const now = Date.now();
  const body = {
    choiceArguments: {
      expectedAdmin: params.expectedAdmin,
      transfer: {
        sender: params.sender,
        receiver: params.receiver,
        amount: params.amount ?? '1.0',
        instrumentId: { admin: params.expectedAdmin, id: params.instrumentId ?? 'Amulet' },
        requestedAt: new Date(now - 1000).toISOString(),
        executeBefore: new Date(now + 3600_000).toISOString(),
        // Context computation does not need real holdings.
        inputHoldingCids: [],
        meta: { values: {} },
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } },
    },
    excludeDebugFields: true,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.token) headers['Authorization'] = `Bearer ${params.token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${base}/registry/transfer-instruction/v1/transfer-factory`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Recipient pre-flight failed: registry ${res.status}: ${detail}`);
  }
  const payload = (await res.json()) as Record<string, unknown>;
  const rawKind = String(payload['transferKind'] ?? payload['kind'] ?? 'unknown');
  const transferKind: TransferKind =
    rawKind === 'direct' || rawKind === 'offer' || rawKind === 'self' ? rawKind : 'unknown';

  const guidance =
    transferKind === 'direct'
      ? 'Recipient holds a TransferPreapproval — stream cycles deliver hands-free.'
      : transferKind === 'offer'
        ? 'Recipient has NO TransferPreapproval: each cycle becomes a two-step offer they must accept. ' +
          'Ask the recipient to create a TransferPreapproval in their validator wallet before activating the stream.'
        : transferKind === 'self'
          ? 'Sender and receiver are the same party (test topology) — delivery is trivially possible.'
          : `Registry returned an unrecognized transfer kind ("${rawKind}") — verify the recipient party manually.`;

  return { deliverable: transferKind === 'direct' || transferKind === 'self', transferKind, guidance };
}
