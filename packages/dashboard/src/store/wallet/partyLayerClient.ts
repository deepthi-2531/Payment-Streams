/**
 * STR-131 — PartyLayer-backed StreamsWalletClient.
 *
 * Wraps `@partylayer/sdk`'s `PartyLayerClient` into the
 * dashboard-neutral `StreamsWalletClient` contract from `./types.ts`.
 *
 * Why lazy-load the SDK: `@partylayer/sdk` pulls in six adapter
 * packages (`@partylayer/adapter-{bron,cantor8,console,loop,nightly,send}`),
 * a registry client, the CIP-0103 provider bridge, and the
 * registry HTTP client. The default LocalNet path (the
 * `dapp-sdk` layer) does not need any of that, so we keep the
 * dynamic `import('@partylayer/sdk')` inside `ensureClient` —
 * Vite tree-splits the resulting chunk and the PartyLayer bundle
 * is only fetched when `VITE_WALLET_LAYER=partylayer` is set
 * (or when the resolver in `./index.ts` selects this client).
 *
 * Capability mapping (STR-132):
 *   - hostedMultiWallet      = true (PartyLayer IS a multi-wallet picker)
 *   - openSurfacesWalletUi   = false (the picker handles visibility itself;
 *                                    there is no analogue to dapp-sdk's
 *                                    `open()` that brings a connected wallet
 *                                    forward — the wallet is the picker)
 *   - ledgerApi              = true  (PartyLayerClient.ledgerApi proxies the
 *                                    request through the active adapter)
 *   - prepareExecuteAndWait  = true  (routed through `asProvider()`'s
 *                                    CIP-0103 Provider, which exposes the
 *                                    canonical `prepareExecuteAndWait`)
 *   - v2AllocationRequestUx  = the wallet's native UX, not PartyLayer's.
 *                              The picker can target an Amulet build that
 *                              supports the splice#5697 receiver UX, but
 *                              also user-selectable wallets that do not.
 *                              We claim `true` only because the picker can
 *                              route to a V2-capable wallet; the actual
 *                              UX still depends on which wallet the user
 *                              chooses. Documented in HOSTED-WALLET-PLAN.md.
 *
 * Event mapping: PartyLayer fires session-level events
 * (`session.connected`, `session.disconnected`, `session.expired`,
 * `tx.status`). We surface these on the dashboard's status /
 * connected / accounts / tx subscribers. The dashboard does not
 * currently distinguish "the wallet identity changed" vs "the
 * session was rotated"; both surface as `onStatusChanged`.
 */

import type {
  StreamsWalletAccount,
  StreamsWalletAccountsHandler,
  StreamsWalletClient,
  StreamsWalletConnectResult,
  StreamsWalletStatus,
  StreamsWalletStatusHandler,
  StreamsWalletTxChangedHandler,
} from './types.js';
import { PARTYLAYER_APP_NAME, PARTYLAYER_NETWORK } from './config.js';

// Minimal structural type — keeps this file from importing the full
// `@partylayer/sdk` value namespace at module load. The runtime types
// come from the dynamic import inside `ensureClient`.
type PartyLayerClientLike = {
  connect: (options?: unknown) => Promise<unknown>;
  disconnect: () => Promise<void>;
  getActiveSession: () => Promise<{
    sessionId: string;
    walletId: string;
    partyId: string;
    network: string;
  } | null>;
  ledgerApi: (params: unknown) => Promise<unknown>;
  asProvider: () => {
    request: (payload: { method: string; params?: unknown }) => Promise<unknown>;
  };
  on: (event: string, handler: (event: unknown) => void) => () => void;
  destroy: () => void;
};

let clientPromise: Promise<PartyLayerClientLike> | null = null;

async function ensureClient(): Promise<PartyLayerClientLike> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const mod = await import('@partylayer/sdk');
      // `createPartyLayer` registers the built-in adapter set
      // (Console + Loop + Cantor8 by default; Bron requires OAuth
      // so we leave it off). The dashboard uses the picker's
      // default UI; per-app branding is in PartyLayer's tickets.
      return mod.createPartyLayer({
        network: PARTYLAYER_NETWORK as never,
        app: { name: PARTYLAYER_APP_NAME },
      }) as unknown as PartyLayerClientLike;
    })();
  }
  return clientPromise;
}

function emptyStatus(): StreamsWalletStatus {
  return {
    provider: null,
    connection: { isConnected: false, isNetworkConnected: false },
    network: null,
    session: null,
  };
}

async function snapshotStatus(): Promise<StreamsWalletStatus> {
  const client = await ensureClient();
  const session = await client.getActiveSession();
  if (!session) return emptyStatus();
  return {
    provider: {
      id: session.walletId,
      name: session.walletId,
      providerType: 'partylayer',
    },
    connection: { isConnected: true, isNetworkConnected: true },
    network: { networkId: session.network },
    session: { userId: session.partyId },
  };
}

async function snapshotAccounts(): Promise<readonly StreamsWalletAccount[]> {
  const client = await ensureClient();
  const session = await client.getActiveSession();
  if (!session) return [];
  return [
    {
      primary: true,
      partyId: session.partyId,
      signingProviderId: session.walletId,
    },
  ];
}

// Event-handler bookkeeping. PartyLayer's `on()` returns an
// unsubscribe function we need to memo per-listener so the symmetric
// `removeOn*` calls actually unsubscribe the right closure.
const subscriptions = new WeakMap<object, () => void>();

async function subscribeStatus(listener: StreamsWalletStatusHandler) {
  if (subscriptions.has(listener as unknown as object)) return;
  const client = await ensureClient();
  const onConnected = client.on('session.connected', () => {
    void snapshotStatus().then((s) => listener(s));
  });
  const onDisconnected = client.on('session.disconnected', () => {
    listener(emptyStatus());
  });
  const onExpired = client.on('session.expired', () => {
    listener(emptyStatus());
  });
  subscriptions.set(listener as unknown as object, () => {
    onConnected();
    onDisconnected();
    onExpired();
  });
}

async function subscribeAccounts(listener: StreamsWalletAccountsHandler) {
  if (subscriptions.has(listener as unknown as object)) return;
  const client = await ensureClient();
  const onConnected = client.on('session.connected', () => {
    void snapshotAccounts().then((a) => listener(a));
  });
  const onDisconnected = client.on('session.disconnected', () => {
    listener([]);
  });
  subscriptions.set(listener as unknown as object, () => {
    onConnected();
    onDisconnected();
  });
}

async function subscribeTx(listener: StreamsWalletTxChangedHandler) {
  if (subscriptions.has(listener as unknown as object)) return;
  const client = await ensureClient();
  const unsubscribe = client.on('tx.status', (event) => listener(event));
  subscriptions.set(listener as unknown as object, unsubscribe);
}

function unsubscribeAny(listener: object): void {
  const fn = subscriptions.get(listener);
  if (fn) {
    fn();
    subscriptions.delete(listener);
  }
}

export const partyLayerWalletClient: StreamsWalletClient = {
  layer: 'partylayer',
  name: 'PartyLayer hosted wallets',
  supportsHostedMultiWallet: true,
  capabilities: {
    ledgerApi: true,
    prepareExecuteAndWait: true,
    // The wallet's V2 receiver UX depends on which wallet the user
    // picks. The picker itself does not gate this. See
    // docs/HOSTED-WALLET-PLAN.md "Support matrix".
    v2AllocationRequestUx: true,
    hostedMultiWallet: true,
    openSurfacesWalletUi: false,
  },

  async init() {
    await ensureClient();
  },

  async connect(): Promise<StreamsWalletConnectResult> {
    const client = await ensureClient();
    await client.connect();
    return { isConnected: true, isNetworkConnected: true };
  },

  async disconnect() {
    const client = await ensureClient();
    await client.disconnect();
  },

  async status() {
    return snapshotStatus();
  },

  async listAccounts() {
    return snapshotAccounts();
  },

  async open() {
    // PartyLayer's picker handles its own visibility through the
    // wallet adapter (e.g. opening the Console extension popup or
    // the Loop deep-link). There is no separate "bring forward"
    // primitive — `connect()` already drove the picker. We surface
    // a no-op so call-sites stay uniform.
  },

  async ledgerApi(params: unknown) {
    const client = await ensureClient();
    return client.ledgerApi(params);
  },

  async prepareExecuteAndWait(params: unknown) {
    const client = await ensureClient();
    const provider = client.asProvider();
    return provider.request({
      method: 'prepareExecuteAndWait',
      params,
    });
  },

  async describeConnectError(err: unknown): Promise<string> {
    const raw = err instanceof Error ? err.message : String(err);
    if (!raw) return 'PartyLayer wallet connection failed';
    if (/user.?rejected/i.test(raw)) {
      return 'You declined the wallet connection in the picker. Click "Connect wallet" to try again.';
    }
    if (/wallet.?not.?(installed|found)/i.test(raw)) {
      return (
        raw +
        '. Pick a different wallet from the PartyLayer picker, or install one from the linked vendor page.'
      );
    }
    return raw;
  },

  onStatusChanged: subscribeStatus,
  onConnected: subscribeStatus,
  onAccountsChanged: subscribeAccounts,
  onTxChanged: subscribeTx,
  removeOnStatusChanged: async (l) => unsubscribeAny(l as unknown as object),
  removeOnConnected: async (l) => unsubscribeAny(l as unknown as object),
  removeOnAccountsChanged: async (l) => unsubscribeAny(l as unknown as object),
  removeOnTxChanged: async (l) => unsubscribeAny(l as unknown as object),
};
