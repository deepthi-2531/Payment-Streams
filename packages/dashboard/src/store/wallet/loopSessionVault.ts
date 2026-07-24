/**
 * Encrypted-at-rest vault for the Loop (5N) session.
 *
 * loop-sdk persists its authorized session (bearer authToken, ticketAuthToken,
 * email/PII) as PLAINTEXT under `localStorage.loop_connect`. We never leave that
 * at rest: the holdings reader lifts the bearer into memory and the plaintext
 * copy is replaced by origin-bound AES-GCM ciphertext under `cs.loopVault`
 * (mirroring the PartyLayer SDK's own at-rest scheme). On load we rehydrate the
 * plaintext `loop_connect` transiently — just long enough for loop-sdk's
 * autoConnect to re-establish the session — then strip it again.
 *
 * The AES key is derived from the page origin (not a secret), so a blind
 * localStorage dump exfiltrated off-origin cannot be decrypted, and a blob from
 * another origin fails the GCM auth check. This is the same protection the
 * SDK's `partylayer_active_session` already relies on.
 */

const VAULT_KEY = 'cs.loopVault';
const LOOP_KEY = 'loop_connect';

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function subtle(): SubtleCrypto | null {
  try {
    return typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null;
  } catch {
    return null;
  }
}

async function deriveKey(): Promise<CryptoKey | null> {
  const s = subtle();
  if (!s || typeof window === 'undefined') return null;
  const material = await s.digest(
    'SHA-256',
    new TextEncoder().encode(`cs-loop-vault:${window.location.origin}`),
  );
  return s.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toB64(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function encrypt(plaintext: string): Promise<string | null> {
  const key = await deriveKey();
  const s = subtle();
  if (!key || !s) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await s.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv);
  combined.set(ct, iv.length);
  return toB64(combined);
}

async function decrypt(b64: string): Promise<string | null> {
  const key = await deriveKey();
  const s = subtle();
  if (!key || !s) return null;
  const raw = fromB64(b64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await s.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** True when an encrypted Loop session is stored — used to hold the restore
 * splash on load for a returning Loop user. */
export function hasVaultedLoopSession(): boolean {
  return Boolean(ls()?.getItem(VAULT_KEY));
}

/**
 * Encrypt the live plaintext `loop_connect` into the vault, then remove the
 * plaintext copy. No-op if there is nothing to stash. Never throws — on any
 * crypto/storage failure it leaves state unchanged (never worse than the
 * pre-existing "strip plaintext" behavior, which we still apply as a fallback).
 */
export async function stashLoopSession(): Promise<void> {
  const store = ls();
  if (!store) return;
  let raw: string | null;
  try {
    raw = store.getItem(LOOP_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const cipher = await encrypt(raw);
    if (cipher) {
      store.setItem(VAULT_KEY, cipher);
      store.removeItem(LOOP_KEY);
    } else {
      // No WebCrypto (should not happen on https) — fall back to the original
      // hardening: drop the plaintext bearer rather than leave it at rest.
      store.removeItem(LOOP_KEY);
    }
  } catch {
    try {
      store.removeItem(LOOP_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rehydrate the plaintext `loop_connect` from the vault so loop-sdk's
 * autoConnect can re-establish the session on load. No-op if `loop_connect` is
 * already present or the vault is empty. Fail-closed: a decrypt failure (wrong
 * origin / tampered / stale scheme) drops the unusable vault entry.
 */
export async function rehydrateLoopSession(): Promise<void> {
  const store = ls();
  if (!store) return;
  try {
    if (store.getItem(LOOP_KEY)) return;
    const cipher = store.getItem(VAULT_KEY);
    if (!cipher) return;
    const plain = await decrypt(cipher);
    if (plain) store.setItem(LOOP_KEY, plain);
    else store.removeItem(VAULT_KEY);
  } catch {
    try {
      store.removeItem(VAULT_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Remove both the vault and any plaintext copy — called on explicit disconnect
 * so an abandoned Loop session can't be silently restored next load. */
export function clearLoopVault(): void {
  const store = ls();
  if (!store) return;
  for (const k of [VAULT_KEY, LOOP_KEY]) {
    try {
      store.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}
