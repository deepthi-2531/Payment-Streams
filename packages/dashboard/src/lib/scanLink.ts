/**
 * @module lib/scanLink
 *
 * Builds a human-clickable on-chain verification link for a settle's update id,
 * and decides whether that id is a REAL ledger reference (vs a placeholder). The
 * V1 settle UI uses these so it only claims "settled" when the claim is
 * independently checkable.
 *
 * The link points at a PUBLIC block explorer (CCView by default; Lighthouse or
 * any other via env) — NOT the SV Scan REST API, which is IP-whitelisted to the
 * validator's egress and therefore unreachable from an end user's browser. The
 * full update id is always shown next to the link too, so it can be pasted into
 * any explorer's search even if a deep-link format drifts.
 *
 * Defaults by VITE_PARTYLAYER_NETWORK:
 *   testnet/devnet → https://testnet.ccview.io
 *   mainnet        → https://ccview.io
 * Override the host with VITE_EXPLORER_BASE_URL and the per-update path template
 * with VITE_EXPLORER_TX_PATH (use `{id}` as the placeholder), e.g. to switch to
 * Lighthouse.
 */

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};

const MAINNET_EXPLORER = 'https://ccview.io';
const TEST_EXPLORER = 'https://testnet.ccview.io';

function isMainnet(): boolean {
  const n = (env.VITE_PARTYLAYER_NETWORK ?? 'testnet').toLowerCase();
  return n === 'mainnet' || n === 'main';
}

/** Public explorer host for the configured network; an env override wins. */
export function explorerBaseUrl(): string {
  const override = env.VITE_EXPLORER_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  return isMainnet() ? MAINNET_EXPLORER : TEST_EXPLORER;
}

/** Display name for the explorer, derived from the host (for the link label). */
export function explorerName(): string {
  try {
    const host = new URL(explorerBaseUrl()).hostname.replace(/^www\./, '');
    if (host.includes('ccview')) return 'CCView';
    if (host.includes('lighthouse')) return 'Lighthouse';
    if (host.includes('cantonscan')) return 'Cantonscan';
    return host;
  } catch {
    return 'explorer';
  }
}

/**
 * True only for a genuine, on-ledger update id — long, hex-ish, and not one of
 * the proxy/dashboard placeholders. This is the single gate that decides whether
 * a settle may be shown as "confirmed on chain".
 */
export function isVerifiableUpdateId(id: string | undefined | null): id is string {
  return (
    typeof id === 'string' &&
    id.length >= 16 &&
    id !== 'wallet-submitted' &&
    id !== 'n/a' &&
    !id.startsWith('<') &&
    !id.startsWith('dashboard-') &&
    /^[0-9a-fA-F:_-]+$/.test(id)
  );
}

/**
 * Public-explorer URL that shows the transfer for a given update id.
 *
 * CCView keys a transfer by `{updateId}:{eventNodeIndex}` (the same node index
 * Scan uses in `events_by_id`). For our V1 settles the `TransferFactory_Transfer`
 * is the ROOT exercise — node index 0 — so the default appends `:0`. Override the
 * whole template (incl. the suffix) with VITE_EXPLORER_TX_PATH, e.g. for an
 * explorer that takes the bare update id (`/tx/{id}`).
 */
export function explorerUpdateUrl(updateId: string): string {
  const template = env.VITE_EXPLORER_TX_PATH ?? '/transfers/{id}:0/';
  return `${explorerBaseUrl()}${template.replace('{id}', encodeURIComponent(updateId))}`;
}
