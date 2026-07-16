/**
 * Combined wallet client — shows PartyLayer wallets AND dapp-sdk wallets in one
 * in-page picker, then routes each selection to the layer that owns it (Loop →
 * PartyLayer; the gateway / discovered CIP-103 wallets → dapp-sdk). Everything
 * else delegates to whichever layer is active once connected.
 */

import { SHOW_FULL_CATALOG } from './config.js';
import { dappSdkWalletClient } from './dappSdkClient.js';
import { partyLayerWalletClient } from './partyLayerClient.js';
import { openWalletPickerModal } from './walletPickerModal.js';
import type {
  StreamsWalletAccount,
  StreamsWalletClient,
  StreamsWalletConnectResult,
  StreamsWalletEntry,
  StreamsWalletStatus,
  StreamsWalletStatusHandler,
  StreamsWalletAccountsHandler,
  StreamsWalletTxChangedHandler,
  WalletCapabilities,
  WalletLayer,
} from './types.js';

type OwnedLayer = 'partylayer' | 'dapp-sdk';

// walletId -> owning layer, populated by buildMergedRows().
const owner = new Map<string, OwnedLayer>();
let activeLayer: OwnedLayer | null = null;

function activeClient(): StreamsWalletClient | null {
  if (activeLayer === 'partylayer') return partyLayerWalletClient;
  if (activeLayer === 'dapp-sdk') return dappSdkWalletClient;
  return null;
}

const DISCONNECTED: StreamsWalletStatus = {
  provider: null,
  connection: { isConnected: false, isNetworkConnected: false },
  network: null,
  session: null,
};

// PartyLayer's catalog is Console/Loop/Cantor8/Nightly/Send; only Loop works on
// our networks, so default to it. SHOW_FULL_CATALOG lists the rest as disabled.
function isWorkingPartyLayerWallet(e: StreamsWalletEntry): boolean {
  return /loop/i.test(e.id) || /loop/i.test(e.name);
}

async function safeList(
  client: StreamsWalletClient,
): Promise<readonly StreamsWalletEntry[]> {
  try {
    return client.listWallets ? await client.listWallets() : [];
  } catch {
    return [];
  }
}

interface MergedRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly badge: string;
  readonly disabled?: boolean;
  readonly installUrl?: string;
}

async function buildMergedRows(): Promise<MergedRow[]> {
  const [pl, ds] = await Promise.all([
    safeList(partyLayerWalletClient),
    safeList(dappSdkWalletClient),
  ]);
  owner.clear();
  const rows: MergedRow[] = [];

  for (const e of pl) {
    const working = isWorkingPartyLayerWallet(e);
    if (!working && !SHOW_FULL_CATALOG) continue;
    owner.set(e.id, 'partylayer');
    rows.push({
      id: e.id,
      name: e.name,
      description: e.description,
      badge: working ? 'Loop' : 'Hosted',
      disabled: !working && e.installed === false,
      installUrl: e.installUrl,
    });
  }

  for (const e of ds) {
    owner.set(e.id, 'dapp-sdk');
    rows.push({
      id: e.id,
      name: e.name,
      description: e.description,
      badge: e.id.startsWith('remote:') ? 'Gateway' : 'CIP-103',
    });
  }
  return rows;
}

function ownerFor(walletId: string): OwnedLayer {
  return (
    owner.get(walletId) ??
    (walletId.startsWith('remote:') || walletId.startsWith('browser:')
      ? 'dapp-sdk'
      : 'partylayer')
  );
}

// Delegate to the owning layer's direct connect. Called synchronously in the
// row-click gesture so the gateway login popup (opened inside dapp-sdk connect)
// isn't blocked.
function connectTo(walletId: string): Promise<StreamsWalletConnectResult> {
  activeLayer = ownerFor(walletId);
  return activeLayer === 'partylayer'
    ? partyLayerWalletClient.connect(walletId)
    : dappSdkWalletClient.connect(walletId);
}

// Listeners are buffered here and (re)attached to the active layer after
// connect, so the dashboard subscribes once and receives the active wallet's
// events regardless of which layer it picked.
const listeners = {
  status: new Set<StreamsWalletStatusHandler>(),
  accounts: new Set<StreamsWalletAccountsHandler>(),
  connected: new Set<StreamsWalletStatusHandler>(),
  tx: new Set<StreamsWalletTxChangedHandler>(),
};

async function attachAll(): Promise<void> {
  const c = activeClient();
  if (!c) return;
  for (const l of listeners.status) await c.onStatusChanged(l);
  for (const l of listeners.accounts) await c.onAccountsChanged(l);
  for (const l of listeners.connected) await c.onConnected(l);
  for (const l of listeners.tx) await c.onTxChanged(l);
}

async function detachAll(client: StreamsWalletClient): Promise<void> {
  for (const l of listeners.status) await client.removeOnStatusChanged(l);
  for (const l of listeners.accounts) await client.removeOnAccountsChanged(l);
  for (const l of listeners.connected) await client.removeOnConnected(l);
  for (const l of listeners.tx) await client.removeOnTxChanged(l);
}

async function afterConnect(
  result: StreamsWalletConnectResult,
): Promise<StreamsWalletConnectResult> {
  if (result.isConnected) await attachAll();
  else activeLayer = null;
  return result;
}

const PRECONNECT_CAPS: WalletCapabilities = {
  ledgerApi: true,
  prepareExecuteAndWait: true,
  v2AllocationRequestUx: true,
  // false so ConnectFlow shows the button that opens our merged picker via
  // connect(), rather than the dashboard's single-layer dropdown.
  hostedMultiWallet: false,
  openSurfacesWalletUi: true,
};

export const combinedWalletClient: StreamsWalletClient = {
  name: 'Canton Streams wallets',

  get layer(): WalletLayer {
    return activeLayer ?? 'dapp-sdk';
  },
  get capabilities(): WalletCapabilities {
    return activeClient()?.capabilities ?? PRECONNECT_CAPS;
  },
  get supportsHostedMultiWallet(): boolean {
    return activeClient()?.supportsHostedMultiWallet ?? false;
  },

  async init() {
    await Promise.allSettled([
      partyLayerWalletClient.init(),
      dappSdkWalletClient.init(),
    ]);
  },

  async connect(walletId?: string): Promise<StreamsWalletConnectResult> {
    if (walletId) return afterConnect(await connectTo(walletId));

    const rows = await buildMergedRows();
    return new Promise<StreamsWalletConnectResult>((resolve) => {
      openWalletPickerModal(
        rows,
        {
          onChoose: (row) => {
            // Route synchronously so a gateway login popup opens in-gesture.
            connectTo(row.id).then(
              (r) => void afterConnect(r).then(resolve),
              (err) => {
                activeLayer = null;
                resolve({
                  isConnected: false,
                  reason: err instanceof Error ? err.message : String(err),
                });
              },
            );
          },
          onCancel: () =>
            resolve({
              isConnected: false,
              reason: 'Wallet connection cancelled',
            }),
        },
        { title: 'Connect a wallet' },
      );
    });
  },

  async disconnect() {
    const c = activeClient();
    if (c) {
      await detachAll(c);
      await c.disconnect();
    }
    activeLayer = null;
  },

  async status(): Promise<StreamsWalletStatus> {
    const c = activeClient();
    return c ? c.status() : DISCONNECTED;
  },

  async listAccounts(): Promise<readonly StreamsWalletAccount[]> {
    const c = activeClient();
    return c ? c.listAccounts() : [];
  },

  async listWallets(): Promise<readonly StreamsWalletEntry[]> {
    const rows = await buildMergedRows();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      installed: r.disabled ? false : true,
      installUrl: r.installUrl,
    }));
  },

  async open() {
    await activeClient()?.open();
  },

  ledgerApi(params: unknown) {
    const c = activeClient();
    if (!c?.ledgerApi) throw new Error('No connected wallet');
    return c.ledgerApi(params);
  },

  prepareExecuteAndWait(params: unknown) {
    const c = activeClient();
    if (!c?.prepareExecuteAndWait) {
      throw new Error('Active wallet does not support prepareExecuteAndWait');
    }
    return c.prepareExecuteAndWait(params);
  },

  async describeConnectError(err: unknown): Promise<string> {
    const c = activeClient();
    if (c) return c.describeConnectError(err);
    return err instanceof Error ? err.message : String(err);
  },

  async onStatusChanged(l) {
    listeners.status.add(l);
    await activeClient()?.onStatusChanged(l);
  },
  async onAccountsChanged(l) {
    listeners.accounts.add(l);
    await activeClient()?.onAccountsChanged(l);
  },
  async onConnected(l) {
    listeners.connected.add(l);
    await activeClient()?.onConnected(l);
  },
  async onTxChanged(l) {
    listeners.tx.add(l);
    await activeClient()?.onTxChanged(l);
  },
  async removeOnStatusChanged(l) {
    listeners.status.delete(l);
    await activeClient()?.removeOnStatusChanged(l);
  },
  async removeOnAccountsChanged(l) {
    listeners.accounts.delete(l);
    await activeClient()?.removeOnAccountsChanged(l);
  },
  async removeOnConnected(l) {
    listeners.connected.delete(l);
    await activeClient()?.removeOnConnected(l);
  },
  async removeOnTxChanged(l) {
    listeners.tx.delete(l);
    await activeClient()?.removeOnTxChanged(l);
  },
};
