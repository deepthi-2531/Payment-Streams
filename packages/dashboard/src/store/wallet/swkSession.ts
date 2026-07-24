/**
 * Splice Wallet Kernel (dapp-sdk) persisted-session helpers.
 *
 * The SWK persists its access token, expiry, network id and kernel session to
 * localStorage, and re-establishes a live session inside `sdk.init()` on load.
 * These helpers let the dashboard decide whether that persisted session is worth
 * restoring, and clear it on an explicit disconnect — without reaching into the
 * SDK internals. Only session keys are touched; UI preferences such as the
 * picker's recent list are left alone.
 */

const ACCESS_TOKEN = 'com.splice.wallet.accessToken';
const EXPIRATION = 'com.splice.wallet.expirationDate';
const NETWORK_ID = 'com.splice.wallet.networkId';
const KERNEL_SESSION = 'splice_wallet_kernel_session';
const DISCOVERY_SESSION = 'splice_discovery_client_session';

const SESSION_KEYS = [
  ACCESS_TOKEN,
  EXPIRATION,
  NETWORK_ID,
  KERNEL_SESSION,
  DISCOVERY_SESSION,
];

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** True once the persisted access token is at or past its expiry. A missing
 * expiry is treated as not-expired — the gateway stays the final authority. */
export function isSwkTokenExpired(): boolean {
  const raw = store()?.getItem(EXPIRATION);
  if (!raw) return false;
  const exp = Number.isNaN(Number(raw)) ? Date.parse(raw) : Number(raw);
  if (!Number.isFinite(exp)) return false;
  return Date.now() >= exp;
}

/** Whether a session worth restoring silently is present: a live kernel session
 * and an access token that has not locally expired. Used to hold a neutral
 * splash on first paint only when a restore can actually succeed. */
export function hasRestorableSession(): boolean {
  const s = store();
  if (!s) return false;
  return (
    Boolean(s.getItem(KERNEL_SESSION)) &&
    Boolean(s.getItem(ACCESS_TOKEN)) &&
    !isSwkTokenExpired()
  );
}

/** The network id the persisted session was issued for, if any. */
export function swkPersistedNetworkId(): string | null {
  return store()?.getItem(NETWORK_ID) ?? null;
}

/** Remove every SWK session key so an explicitly-abandoned session cannot be
 * silently re-adopted on the next load — even if the SDK's own disconnect
 * threw. Called from the dapp-sdk layer's disconnect(). */
export function clearSwkPersistedSession(): void {
  const s = store();
  if (!s) return;
  for (const k of SESSION_KEYS) {
    try {
      s.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}
