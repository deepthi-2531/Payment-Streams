import type {
  StreamsWalletAccountsHandler,
  StreamsWalletClient,
  StreamsWalletStatusHandler,
  StreamsWalletTxChangedHandler,
} from './types.js';

const NOT_READY =
  'PartyLayer hosted wallet mode is planned but not wired yet. ' +
  'Use VITE_WALLET_LAYER=dapp-sdk for LocalNet/Amulet testing until DEX-85 lands.';

async function notReady(): Promise<never> {
  throw new Error(NOT_READY);
}

export const unsupportedPartyLayerClient: StreamsWalletClient = {
  layer: 'partylayer',
  name: 'PartyLayer hosted wallets',
  supportsHostedMultiWallet: true,

  init: notReady,
  connect: notReady,
  disconnect: notReady,
  status: notReady,
  listAccounts: notReady,
  open: notReady,

  describeConnectError: async (err: unknown) =>
    err instanceof Error ? err.message : NOT_READY,

  onStatusChanged: async (_listener: StreamsWalletStatusHandler) => {},
  onAccountsChanged: async (_listener: StreamsWalletAccountsHandler) => {},
  onConnected: async (_listener: StreamsWalletStatusHandler) => {},
  onTxChanged: async (_listener: StreamsWalletTxChangedHandler) => {},
  removeOnStatusChanged: async (_listener: StreamsWalletStatusHandler) => {},
  removeOnAccountsChanged: async (_listener: StreamsWalletAccountsHandler) => {},
  removeOnConnected: async (_listener: StreamsWalletStatusHandler) => {},
  removeOnTxChanged: async (_listener: StreamsWalletTxChangedHandler) => {},
};
