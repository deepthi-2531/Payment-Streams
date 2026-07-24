import {
  DappSDK,
  RemoteAdapter,
  type WalletPickerFn,
} from '@canton-network/dapp-sdk';
import {
  SKIP_PICKER,
  WALLET_GATEWAY_URL,
  WALLET_NAME,
} from './config.js';
import {
  openWalletPickerModal,
  type WalletPickerRow,
} from './walletPickerModal.js';
import { clearSwkPersistedSession, isSwkTokenExpired } from './swkSession.js';
import type {
  StreamsWalletAccountsHandler,
  StreamsWalletClient,
  StreamsWalletEntry,
  StreamsWalletStatus,
  StreamsWalletStatusHandler,
  StreamsWalletTxChangedHandler,
} from './types.js';

const DISCONNECTED: StreamsWalletStatus = {
  provider: null,
  connection: { isConnected: false },
  network: null,
  session: null,
};

/** Read the SDK's status, normalizing the pre-connect "Not connected" throw to
 * a disconnected snapshot (the expected no-session state, not an error). */
async function snapshotDappStatus(): Promise<StreamsWalletStatus> {
  try {
    return await sdk.status();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/not connected|call connect\(\) first/i.test(raw)) return DISCONNECTED;
    throw err;
  }
}

const REMOTE_PROVIDER_ID = `remote:${WALLET_GATEWAY_URL}`;

type PickerEntry = {
  readonly providerId: string;
  readonly name: string;
  readonly type: string;
  readonly url?: string;
  readonly icon?: string;
  readonly description?: string;
  readonly reuseGlobalWalletPopup?: boolean;
};

async function autoRemotePicker(entries: readonly PickerEntry[]): Promise<PickerEntry> {
  const remote = entries.find((e) => e.type === 'remote' && e.url);
  if (remote) return remote;
  return {
    providerId: REMOTE_PROVIDER_ID,
    name: WALLET_NAME,
    type: 'remote',
    url: WALLET_GATEWAY_URL,
  };
}

// The configured gateway is passed as the sole `defaultAdapters` entry, which
// replaces the SDK's baked-in `localhost:3030` default (instead of leaving it as
// a dead picker entry). Injected/announced CIP-103 wallets are still discovered
// independently of `defaultAdapters`.
const configuredGatewayAdapter = new RemoteAdapter({
  providerId: REMOTE_PROVIDER_ID,
  name: WALLET_NAME,
  rpcUrl: WALLET_GATEWAY_URL,
  description: 'CIP-103 Splice / Amulet wallet gateway',
});

const initOptions = {
  defaultAdapters: [configuredGatewayAdapter],
};

// When set (by connect(walletId)), the picker auto-selects that providerId with
// no UI — used by the combined layer, which already picked the wallet.
let pendingWalletId: string | null = null;

// Custom picker so the SDK never falls back to its default `pickWallet`, which
// renders into a blob:-URL popup our `script-src 'self'` CSP blanks out.
// Priority: pending selection -> skip-picker single gateway -> in-page picker.
async function dappSelectWallet(
  entries: readonly PickerEntry[],
): Promise<PickerEntry> {
  if (pendingWalletId) {
    const match = entries.find((e) => e.providerId === pendingWalletId);
    if (match) return match;
    // Requested wallet not discovered — fall through to a picker.
  }
  if (SKIP_PICKER) return autoRemotePicker(entries);
  return inPageWalletPicker(entries);
}

const sdk: DappSDK = new DappSDK({
  walletPicker: dappSelectWallet as unknown as WalletPickerFn,
});

// The gateway login popup. The SDK opens it only after an async connect()
// round-trip (gesture-detached → blocked), and its blank `window.open("",
// "wallet-popup")` is blocked outright by strict browsers. So we pre-open the
// same-named window synchronously in the user gesture, pointed at a real
// same-origin URL; the SDK's later popup.open(userUrl) reuses it.
const WALLET_POPUP_NAME = 'wallet-popup';
const WALLET_POPUP_FEATURES = 'width=420,height=640,screenX=200,screenY=200';

// The most recently opened login popup, tracked so connect() can close it if
// the connection never completes (error / cancel).
let activeWalletPopup: Window | null = null;

/** `<base>/api/v0/dapp` -> `<base>/login/` (the gateway's userUrl). */
function deriveGatewayLoginUrl(dappApiUrl: string): string | null {
  try {
    const u = new URL(dappApiUrl);
    const next = u.pathname.replace(/\/api\/v0\/dapp\/?$/, '/login/');
    if (next === u.pathname) return null; // not the expected dApp-API path shape
    u.pathname = next;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Same-origin placeholder (public/wallet-popup.html) — fallback when the login
 * URL can't be derived. Not about:blank, which strict browsers block. */
function walletPopupPlaceholderUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    const base = env?.BASE_URL ?? '/';
    return new URL(`${base}wallet-popup.html`, window.location.origin).toString();
  } catch {
    return null;
  }
}

/** Open the "wallet-popup" login window. Must be called inside a user gesture
 * (before any await) so the popup isn't blocked. */
function openWalletPopup(): Window | null {
  if (typeof window === 'undefined') return null;
  const target =
    deriveGatewayLoginUrl(WALLET_GATEWAY_URL) ??
    walletPopupPlaceholderUrl() ??
    'about:blank';
  try {
    activeWalletPopup = window.open(
      target,
      WALLET_POPUP_NAME,
      WALLET_POPUP_FEATURES,
    );
    return activeWalletPopup;
  } catch {
    return null;
  }
}

/** Close the login popup if connect never completed (error / cancel). */
function closeWalletPopup(): void {
  const win = activeWalletPopup;
  activeWalletPopup = null;
  if (win && !win.closed) {
    try {
      win.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// In-page wallet picker
//
// Replaces the SWK dapp-sdk's default `pickWallet`, which renders the
// swk-wallet-picker web component into a blob:-URL popup document. Under our CSP
// (`script-src 'self'`) that blob document's inline <script> is blocked (opaque
// blob origin ≠ 'self', no 'unsafe-inline'), so the popup loaded BLANK. Instead
// we render the wallet list in the dashboard DOM — same 'self' origin (scripts
// already allowed), inline styles allowed by `style-src 'unsafe-inline'` — and
// resolve with the chosen entry. This removes the blob popup for the picker
// step entirely. The gateway LOGIN still uses the working real-URL
// "wallet-popup", opened here on the user's wallet-selection click.
function inPageWalletPicker(
  entries: readonly PickerEntry[],
): Promise<PickerEntry> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('No DOM available for wallet picker'));
      return;
    }
    const byId = new Map(entries.map((e) => [e.providerId, e] as const));
    const rows: WalletPickerRow[] = entries.map((e) => ({
      id: e.providerId,
      name: e.name,
      description: e.description,
      icon: e.icon,
      badge: e.type === 'remote' ? 'Gateway' : 'Extension',
    }));
    openWalletPickerModal(
      rows,
      {
        onChoose: (row) => {
          const entry = byId.get(row.id);
          if (!entry) {
            reject(new Error('Wallet selection not found'));
            return;
          }
          // Only a REMOTE gateway needs our pre-opened login popup (the SDK's
          // RemoteAdapter opens the gateway login via popup.open(userUrl), which
          // we pre-open here in this fresh user gesture so it isn't blocked).
          // Injected (`window.canton`) / announced browser-extension wallets
          // drive their OWN UI, so we must NOT open the gateway login for them.
          if (entry.type === 'remote') openWalletPopup();
          resolve(entry);
        },
        onCancel: () => reject(new Error('Wallet connection cancelled')),
      },
      { title: 'Connect a wallet' },
    );
  });
}

function isProviderLike(o: unknown): boolean {
  if (typeof o !== 'object' || o === null) return false;
  const p = o as Record<string, unknown>;
  return (
    typeof p.request === 'function' &&
    typeof p.on === 'function' &&
    typeof p.emit === 'function' &&
    typeof p.removeListener === 'function'
  );
}

// Mirror the SDK's discovery (window.canton + the canton:announceProvider
// handshake) so the combined layer can list installed CIP-103 wallets without
// connecting. Ids match the SDK adapter providerIds, so connect(id) routes back
// to the same wallet.
function discoverInjectedWallets(): StreamsWalletEntry[] {
  if (typeof window === 'undefined') return [];
  const out: StreamsWalletEntry[] = [];
  const win = window as unknown as Record<string, unknown>;
  const cand = win['canton'];
  if (cand == null) return out;
  if (isProviderLike(cand)) {
    out.push({
      id: 'browser:canton',
      name: 'canton (injected)',
      description: 'Injected provider from window.canton',
      cip0103Native: true,
      installed: true,
    });
  } else if (typeof cand === 'object') {
    for (const [key, val] of Object.entries(cand as Record<string, unknown>)) {
      if (isProviderLike(val)) {
        out.push({
          id: `browser:canton.${key}`,
          name: `canton.${key} (injected)`,
          description: `Injected provider from window.canton.${key}`,
          cip0103Native: true,
          installed: true,
        });
      }
    }
  }
  return out;
}

async function discoverAnnouncedWallets(): Promise<StreamsWalletEntry[]> {
  if (typeof window === 'undefined') return [];
  const found = new Map<string, StreamsWalletEntry>();
  const handler = (e: Event) => {
    const d = (e as CustomEvent).detail as
      | { id?: string; name?: string }
      | undefined;
    if (!d?.id || !d.name || found.has(d.id)) return;
    found.set(d.id, {
      id: `browser:ext:${d.id}`,
      name: d.name,
      description: 'Connect via a browser extension wallet',
      cip0103Native: true,
      installed: true,
    });
  };
  window.addEventListener('canton:announceProvider', handler);
  try {
    window.dispatchEvent(
      new CustomEvent('canton:requestProvider', { detail: {} }),
    );
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    window.removeEventListener('canton:announceProvider', handler);
  }
  return [...found.values()];
}

/** The configured gateway plus any discovered CIP-103 wallets. */
async function listDappSdkWallets(): Promise<StreamsWalletEntry[]> {
  const gateway: StreamsWalletEntry = {
    id: REMOTE_PROVIDER_ID,
    name: WALLET_NAME,
    description: 'CIP-103 Splice / Amulet wallet gateway',
    cip0103Native: true,
    installed: true,
  };
  const announced = await discoverAnnouncedWallets();
  const seen = new Set<string>();
  return [gateway, ...discoverInjectedWallets(), ...announced].filter(
    (e) => !seen.has(e.id) && seen.add(e.id),
  );
}

async function assertRemoteWalletReachable(): Promise<void> {
  try {
    const response = await fetch(WALLET_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'streams-wallet-preflight',
        method: 'status',
        params: {},
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    const suffix = err instanceof Error ? ` (${err.message})` : '';
    throw new Error(
      `Amulet wallet gateway is not reachable at ${WALLET_GATEWAY_URL}${suffix}. ` +
        'Start the Splice LocalNet validator Amulet wallet gateway, ' +
        'then retry Connect wallet.',
    );
  }
}

async function describeConnectError(err: unknown): Promise<string> {
  const raw = err instanceof Error ? err.message : String(err);
  if (!SKIP_PICKER || !/not connected/i.test(raw)) {
    return raw || 'Wallet connection failed';
  }

  try {
    await assertRemoteWalletReachable();
  } catch (preflightErr) {
    return preflightErr instanceof Error
      ? preflightErr.message
      : 'Amulet wallet gateway is not reachable. Start the wallet gateway, then retry Connect wallet.';
  }

  return (
    `Amulet wallet gateway is reachable at ${WALLET_GATEWAY_URL}, ` +
    'but no wallet session is connected. Open the Amulet wallet gateway UI, sign in, then retry Connect wallet.'
  );
}

// ---------------------------------------------------------------------------
// Event-subscription buffering
//
// The dapp-sdk singleton only lets you attach provider event listeners once a
// wallet CLIENT exists (i.e. AFTER connect): onStatusChanged / onAccountsChanged
// / onConnected / onTxChanged all route through `requireClient()`, which throws
// `Not connected — call connect() first` before then. auth.tsx subscribes at
// mount — before connect — so a naive pass-through both (a) flashes that error
// on the connect screen and (b) means the layer never receives live wallet
// events at all. We buffer listeners here and (re)attach them to the live
// client after connect, so the dapp-sdk layer gets the same event-driven
// updates the hosted (PartyLayer) layer does.
// ---------------------------------------------------------------------------

type AnyWalletListener =
  | StreamsWalletStatusHandler
  | StreamsWalletAccountsHandler
  | StreamsWalletTxChangedHandler;

const buffered = {
  statusChanged: new Set<StreamsWalletStatusHandler>(),
  accountsChanged: new Set<StreamsWalletAccountsHandler>(),
  connected: new Set<StreamsWalletStatusHandler>(),
  txChanged: new Set<StreamsWalletTxChangedHandler>(),
};

// Listeners already wired to the CURRENT client. Cleared on disconnect so a
// later connect re-attaches exactly once to the fresh client.
const attached = new WeakSet<object>();

function isNotConnectedError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /not connected|call connect\(\) first/i.test(raw);
}

/** Attach one buffered listener to the live client, tolerating the pre-connect
 * "no client yet" state. Best-effort: never throws, so a mount-time subscribe
 * or a post-connect reattach can't crash the app. */
async function attachOne(
  listener: AnyWalletListener,
  sdkOn: () => Promise<void>,
): Promise<void> {
  if (attached.has(listener)) return;
  try {
    await sdkOn();
    attached.add(listener);
  } catch (err) {
    if (!isNotConnectedError(err)) {
      console.warn('[dapp-sdk] wallet event subscribe failed:', err);
    }
    // No client yet — the listener stays buffered for reattach after connect.
  }
}

/** Re-attach every buffered listener after a successful connect. */
async function reattachBufferedListeners(): Promise<void> {
  for (const l of buffered.statusChanged)
    await attachOne(l, () => sdk.onStatusChanged(l as never));
  for (const l of buffered.accountsChanged)
    await attachOne(l, () => sdk.onAccountsChanged(l as never));
  for (const l of buffered.connected)
    await attachOne(l, () => sdk.onConnected(l as never));
  for (const l of buffered.txChanged)
    await attachOne(l, () => sdk.onTxChanged(l as never));
}

/** Forget attachments after the client is torn down (disconnect), so the
 * still-buffered listeners re-attach to the next client on reconnect. */
function forgetAttachments(): void {
  for (const l of buffered.statusChanged) attached.delete(l);
  for (const l of buffered.accountsChanged) attached.delete(l);
  for (const l of buffered.connected) attached.delete(l);
  for (const l of buffered.txChanged) attached.delete(l);
}

async function detachOne(
  listener: AnyWalletListener,
  sdkOff: () => Promise<void>,
): Promise<void> {
  attached.delete(listener);
  try {
    await sdkOff();
  } catch (err) {
    if (!isNotConnectedError(err)) {
      console.warn('[dapp-sdk] wallet event unsubscribe failed:', err);
    }
  }
}

export const dappSdkWalletClient: StreamsWalletClient = {
  layer: 'dapp-sdk',
  name: 'Amulet / dapp-sdk',
  supportsHostedMultiWallet: false,
  capabilities: {
    ledgerApi: true,
    prepareExecuteAndWait: true,
    v2AllocationRequestUx: true,
    hostedMultiWallet: false,
    openSurfacesWalletUi: true,
  },

  async init() {
    await sdk.init(initOptions);
  },

  async connect(walletId?: string) {
    // With `walletId` the SDK connects directly to that wallet (combined layer);
    // otherwise this layer runs its own in-page picker. Pre-open the login popup
    // in-gesture when a remote gateway is the known target; for the in-page
    // picker path it's opened on the user's row-click instead.
    pendingWalletId = walletId ?? null;
    const remoteTarget = walletId
      ? walletId.startsWith('remote:')
      : SKIP_PICKER;
    if (remoteTarget) openWalletPopup();
    try {
      if (SKIP_PICKER && !walletId) {
        // Single-wallet automation: fail fast with an actionable message if the
        // configured gateway is down, rather than a generic "not connected".
        await assertRemoteWalletReachable();
      }
      const result = await sdk.connect(initOptions);
      // Wire any listeners registered before connect to the now-live client so
      // the layer starts receiving statusChanged/accountsChanged/txChanged.
      await reattachBufferedListeners();
      return result;
    } catch (err) {
      // Connect never completed (error / user cancel) — don't leave a stray
      // login popup behind.
      closeWalletPopup();
      throw err;
    } finally {
      pendingWalletId = null;
    }
  },

  async disconnect() {
    try {
      await sdk.disconnect();
    } finally {
      // The client is torn down; its provider listeners are dead. Forget the
      // attachments so a later connect re-wires the still-buffered listeners.
      forgetAttachments();
      // Clear the persisted session even if the SDK disconnect threw, so an
      // explicitly-abandoned session can't be silently re-adopted next load.
      clearSwkPersistedSession();
    }
  },

  async status() {
    // The pre-connect "Not connected" throw is the expected no-session state,
    // not an error — auth.tsx calls status() on mount, so normalize it instead
    // of flashing a red banner on the connect screen.
    return snapshotDappStatus();
  },

  async restore() {
    // `sdk.init()` (run at mount) already performed the SDK's own popup-free
    // session restore, so status() reflects the restored client. Fail closed on
    // a locally-expired access token so we never adopt a dead session — the
    // gateway's status RPC is the final authority for everything else.
    if (isSwkTokenExpired()) return DISCONNECTED;
    return snapshotDappStatus();
  },

  async listAccounts() {
    return sdk.listAccounts();
  },

  listWallets() {
    return listDappSdkWallets();
  },

  async open() {
    await sdk.open();
  },

  ledgerApi: (params: unknown) =>
    (sdk as unknown as { ledgerApi(params: unknown): Promise<unknown> }).ledgerApi(
      params,
    ),

  prepareExecuteAndWait: (params: unknown) =>
    (
      sdk as unknown as {
        prepareExecuteAndWait(params: unknown): Promise<unknown>;
      }
    ).prepareExecuteAndWait(params),

  describeConnectError,

  async onStatusChanged(listener: StreamsWalletStatusHandler) {
    buffered.statusChanged.add(listener);
    await attachOne(listener, () => sdk.onStatusChanged(listener as never));
  },
  async onAccountsChanged(listener: StreamsWalletAccountsHandler) {
    buffered.accountsChanged.add(listener);
    await attachOne(listener, () => sdk.onAccountsChanged(listener as never));
  },
  async onConnected(listener: StreamsWalletStatusHandler) {
    buffered.connected.add(listener);
    await attachOne(listener, () => sdk.onConnected(listener as never));
  },
  async onTxChanged(listener: StreamsWalletTxChangedHandler) {
    buffered.txChanged.add(listener);
    await attachOne(listener, () => sdk.onTxChanged(listener as never));
  },
  async removeOnStatusChanged(listener: StreamsWalletStatusHandler) {
    buffered.statusChanged.delete(listener);
    await detachOne(listener, () => sdk.removeOnStatusChanged(listener as never));
  },
  async removeOnAccountsChanged(listener: StreamsWalletAccountsHandler) {
    buffered.accountsChanged.delete(listener);
    await detachOne(listener, () =>
      sdk.removeOnAccountsChanged(listener as never),
    );
  },
  async removeOnConnected(listener: StreamsWalletStatusHandler) {
    buffered.connected.delete(listener);
    await detachOne(listener, () => sdk.removeOnConnected(listener as never));
  },
  async removeOnTxChanged(listener: StreamsWalletTxChangedHandler) {
    buffered.txChanged.delete(listener);
    await detachOne(listener, () => sdk.removeOnTxChanged(listener as never));
  },
};
