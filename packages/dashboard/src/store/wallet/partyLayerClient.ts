/**
 * PartyLayer-backed wallet client.
 *
 * The SDK is loaded only when the hosted-wallet layer is selected, keeping
 * the default LocalNet/Amulet path lean. This adapter normalizes PartyLayer's
 * multi-wallet API into the dashboard's wallet-client contract.
 */

import type {
  StreamsWalletAccount,
  StreamsWalletAccountsHandler,
  StreamsWalletClient,
  StreamsWalletConnectResult,
  StreamsWalletEntry,
  StreamsWalletStatus,
  StreamsWalletStatusHandler,
  StreamsWalletTxChangedHandler,
} from './types.js';
import { PARTYLAYER_APP_NAME, PARTYLAYER_NETWORK } from './config.js';

// Minimal structural type — keeps this file from importing the full
// `@partylayer/sdk` value namespace at module load. The runtime types
// come from the dynamic import inside `ensureClient`.
type WalletInfoLike = {
  walletId: string;
  name?: string;
  description?: string;
  homepage?: string;
  installUrl?: string;
  cip0103?: { native?: boolean };
};

type PartyLayerClientLike = {
  connect: (options?: { walletId?: string; preferInstalled?: boolean }) => Promise<unknown>;
  disconnect: () => Promise<void>;
  listWallets: (filter?: unknown) => Promise<WalletInfoLike[]>;
  getAdapter: (walletId: string) => {
    detectInstalled?: () => Promise<{ installed: boolean }>;
  } | undefined;
  getActiveSession: () => Promise<{
    sessionId: string;
    walletId: string;
    partyId: string;
    network: string;
  } | null>;
  ledgerApi: (params: unknown) => Promise<unknown>;
  // Use the provider bridge via ESM; some browser builds cannot execute
  // the CommonJS require used inside client.asProvider().
  on: (event: string, handler: (event: unknown) => void) => () => void;
  destroy: () => void;
};

type CipProviderLike = {
  request: (payload: { method: string; params?: unknown }) => Promise<unknown>;
};

let clientPromise: Promise<PartyLayerClientLike> | null = null;
let providerPromise: Promise<CipProviderLike> | null = null;

/**
 * Drop a persisted Loop session that targets a DIFFERENT Canton network than
 * the one this deployment is configured for. The Loop SDK restores its last
 * session (and its network) from `localStorage["loop_connect"]` on autoConnect,
 * so a leftover devnet session would otherwise hijack a testnet/mainnet deploy
 * and reconnect to the wrong `*.cantonloop.com`. We key off the configured
 * network (`VITE_PARTYLAYER_NETWORK`) so this stays fully env-driven.
 */
function clearStaleLoopSession(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem('loop_connect');
    if (!raw) return;
    // Drop the session only if it explicitly references a DIFFERENT network
    // than the configured one (e.g. a devnet session — host "devnet.cantonloop
    // .com" — on a testnet deploy). Keeping the check to "mentions another
    // network" avoids ever clearing a valid same-network session that simply
    // doesn't spell the network out.
    const others = (['devnet', 'testnet', 'mainnet'] as const).filter(
      (n) => n !== PARTYLAYER_NETWORK,
    );
    if (others.some((n) => raw.includes(n))) {
      // Wrong-network session: wipe EVERY Loop SDK key (loop_connect,
      // loop-wallet, loop-sdk-connect-overlay, …) so autoConnect cannot
      // restore a stale pairing/ticket from any of them.
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const k = localStorage.key(i);
        if (k && /^loop[_-]/i.test(k)) localStorage.removeItem(k);
      }
    }
  } catch {
    // localStorage unavailable (incognito / SSR) — nothing to clear.
  }
}

/**
 * Force a FRESH Loop connect handshake before an explicit connect.
 *
 * The Loop SDK persists its connect handshake ({sessionId, ticketId}) in
 * `localStorage["loop_connect"]` and reuses the cached ticketId on the next
 * connect. Loop's ticket server hands out single-use, short-lived tickets, so
 * once the cached ticket is consumed/expired EVERY reconnect reopens
 * `testnet.cantonloop.com/.connect/?ticketId=<stale>` and the gateway dies with
 * "Failed to Load Connection — the ticket may be invalid or expired" (the ticket
 * server 404s the dead id — verified live: stale ticket → 404, fresh ticket →
 * 401/exists). Dropping the cached handshake makes the SDK mint a fresh, live
 * ticket.
 *
 * Unlike `clearStaleLoopSession` (which only fires for a WRONG-network session),
 * this always runs — but ONLY from `connect()`. The autoConnect/session-resume
 * path on load is left untouched, so a user whose session validly restores never
 * reaches this; a user clicking "Connect" is re-initiating the session anyway.
 */
function resetLoopConnectHandshake(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('loop_connect');
  } catch {
    // localStorage unavailable (incognito / SSR) — nothing to clear.
  }
}

async function ensureClient(): Promise<PartyLayerClientLike> {
  if (!clientPromise) {
    clientPromise = (async () => {
      clearStaleLoopSession();
      const mod = await import('@partylayer/sdk');
      // The default adapter set includes Console, Loop, Cantor8, Nightly,
      // and Send. Bron requires app-specific OAuth configuration.
      return mod.createPartyLayer({
        network: PARTYLAYER_NETWORK as never,
        app: { name: PARTYLAYER_APP_NAME },
      }) as unknown as PartyLayerClientLike;
    })();
  }
  return clientPromise;
}

/** Build and cache the CIP-103 provider bridge used for status reads. */
async function ensureProvider(): Promise<CipProviderLike> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const client = await ensureClient();
      const mod = await import('@partylayer/provider');
      return mod.createProviderBridge(
        client as unknown as Parameters<typeof mod.createProviderBridge>[0],
      ) as unknown as CipProviderLike;
    })();
  }
  return providerPromise;
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
  // PartyLayer's session has the party and wallet ids; the provider status
  // may add network/session metadata for wallets that expose it.
  try {
    const provider = await ensureProvider();
    const cipStatusRaw = await provider.request({
      method: 'status',
      params: {},
    });
    const cipStatus = cipStatusRaw as {
      provider?: { id?: string; name?: string; type?: string };
      connection?: {
        isConnected?: boolean;
        isNetworkConnected?: boolean;
        reason?: string;
      };
      network?: { networkId?: string; accessToken?: string; ledgerApi?: string };
      session?: { accessToken?: string; userId?: string };
    } | null;
    if (cipStatus) {
      return {
        provider: cipStatus.provider
          ? {
              id: cipStatus.provider.id,
              name: cipStatus.provider.name,
              providerType: cipStatus.provider.type,
            }
          : { id: session.walletId, name: session.walletId, providerType: 'partylayer' },
        connection: {
          isConnected: cipStatus.connection?.isConnected ?? true,
          isNetworkConnected: cipStatus.connection?.isNetworkConnected ?? true,
          reason: cipStatus.connection?.reason ?? null,
        },
        network: cipStatus.network ?? { networkId: session.network },
        session: cipStatus.session ?? { userId: session.partyId },
      };
    }
  } catch {
    // Status is best-effort; fall back to the PartyLayer session snapshot.
  }
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

// PartyLayer returns an unsubscribe function per handler; memo it so the
// dashboard can detach the exact subscription later.
const subscriptions = new WeakMap<object, () => void>();

async function subscribeStatus(listener: StreamsWalletStatusHandler) {
  if (subscriptions.has(listener as unknown as object)) return;
  const client = await ensureClient();
  const onConnected = client.on('session:connected', () => {
    void snapshotStatus().then((s) => listener(s));
  });
  const onDisconnected = client.on('session:disconnected', () => {
    listener(emptyStatus());
  });
  const onExpired = client.on('session:expired', () => {
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
  const onConnected = client.on('session:connected', () => {
    void snapshotAccounts().then((a) => listener(a));
  });
  const onDisconnected = client.on('session:disconnected', () => {
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
  const unsubscribe = client.on('tx:status', (event) => listener(event));
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
    // The current provider bridge exposes prepareExecute, but not a
    // wait-for-completion variant.
    prepareExecuteAndWait: false,
    v2AllocationRequestUx: true,
    hostedMultiWallet: true,
    openSurfacesWalletUi: false,
  },

  async init() {
    await ensureClient();
  },

  async connect(walletId?: string): Promise<StreamsWalletConnectResult> {
    const client = await ensureClient();
    // Start every explicit connect from a clean handshake so the Loop SDK mints
    // a fresh ticket instead of reopening a stale/expired one (which 404s the
    // gateway as "ticket invalid or expired").
    resetLoopConnectHandshake();
    try {
      await client.connect(walletId ? { walletId } : { preferInstalled: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isConnected: false, reason: msg || 'Wallet connection failed' };
    }
    // QR/deep-link wallets can resolve before the session is persisted.
    // Only report success once PartyLayer exposes an active session.
    const session = await client.getActiveSession();
    if (!session) {
      return {
        isConnected: false,
        reason:
          'Wallet connection completed but no session was established. ' +
          'Try again — check the wallet popup/QR has been approved.',
      };
    }
    return { isConnected: true, isNetworkConnected: true };
  },

  async listWallets(): Promise<readonly StreamsWalletEntry[]> {
    const client = await ensureClient();
    const wallets = await client.listWallets();
    return Promise.all(
      wallets.map(async (w): Promise<StreamsWalletEntry> => {
        const adapter = client.getAdapter(w.walletId);
        let installed: boolean | undefined;
        try {
          const detect = await adapter?.detectInstalled?.();
          installed = detect?.installed;
        } catch {
          /* ignore; leave installed undefined */
        }
        return {
          id: w.walletId,
          name: w.name ?? w.walletId,
          description: w.description,
          installed,
          installUrl: w.installUrl ?? w.homepage,
          cip0103Native: w.cip0103?.native,
        };
      }),
    );
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
    // The picker owns wallet visibility; there is no separate "bring
    // wallet forward" primitive after connection.
  },

  async ledgerApi(params: unknown) {
    const client = await ensureClient();
    return client.ledgerApi(params);
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
