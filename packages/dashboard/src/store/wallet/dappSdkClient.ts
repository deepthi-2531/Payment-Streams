import {
  DappSDK,
  dappSDK,
  RemoteAdapter,
  type WalletPickerFn,
} from '@canton-network/dapp-sdk';
import {
  SKIP_PICKER,
  WALLET_GATEWAY_URL,
  WALLET_NAME,
} from './config.js';
import type {
  StreamsWalletAccountsHandler,
  StreamsWalletClient,
  StreamsWalletStatusHandler,
  StreamsWalletTxChangedHandler,
} from './types.js';

const REMOTE_PROVIDER_ID = `remote:${WALLET_GATEWAY_URL}`;

type PickerEntry = {
  readonly providerId: string;
  readonly name: string;
  readonly type: string;
  readonly url?: string;
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

const skipPickerInitOptions = SKIP_PICKER
  ? {
      defaultAdapters: [],
      additionalAdapters: [
        new RemoteAdapter({
          providerId: REMOTE_PROVIDER_ID,
          name: WALLET_NAME,
          rpcUrl: WALLET_GATEWAY_URL,
          description: 'CIP-103 Amulet wallet gateway for Token Standard V2 LocalNet',
        }),
      ],
    }
  : undefined;

// dappSDK 1.1.0 only honors `walletPicker` in the DappSDK constructor;
// passing it to `init()` is ignored. Use a dedicated SDK instance for
// the automation/local-Amulet path so no popup picker is created.
const sdk: DappSDK = SKIP_PICKER
  ? new DappSDK({ walletPicker: autoRemotePicker as unknown as WalletPickerFn })
  : dappSDK;

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

export const dappSdkWalletClient: StreamsWalletClient = {
  layer: 'dapp-sdk',
  name: 'Amulet / dapp-sdk',
  supportsHostedMultiWallet: false,

  async init() {
    await (skipPickerInitOptions ? sdk.init(skipPickerInitOptions) : sdk.init());
  },

  async connect() {
    if (SKIP_PICKER) {
      await assertRemoteWalletReachable();
    }
    return skipPickerInitOptions
      ? sdk.connect(skipPickerInitOptions)
      : sdk.connect();
  },

  async disconnect() {
    await sdk.disconnect();
  },

  async status() {
    return sdk.status();
  },

  async listAccounts() {
    return sdk.listAccounts();
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

  onStatusChanged: (listener: StreamsWalletStatusHandler) =>
    sdk.onStatusChanged(listener as never),
  onAccountsChanged: (listener: StreamsWalletAccountsHandler) =>
    sdk.onAccountsChanged(listener as never),
  onConnected: (listener: StreamsWalletStatusHandler) =>
    sdk.onConnected(listener as never),
  onTxChanged: (listener: StreamsWalletTxChangedHandler) =>
    sdk.onTxChanged(listener as never),
  removeOnStatusChanged: (listener: StreamsWalletStatusHandler) =>
    sdk.removeOnStatusChanged(listener as never),
  removeOnAccountsChanged: (listener: StreamsWalletAccountsHandler) =>
    sdk.removeOnAccountsChanged(listener as never),
  removeOnConnected: (listener: StreamsWalletStatusHandler) =>
    sdk.removeOnConnected(listener as never),
  removeOnTxChanged: (listener: StreamsWalletTxChangedHandler) =>
    sdk.removeOnTxChanged(listener as never),
};
