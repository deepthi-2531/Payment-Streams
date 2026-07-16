import { WALLET_LAYER } from './config.js';
import { dappSdkWalletClient } from './dappSdkClient.js';
import { partyLayerWalletClient } from './partyLayerClient.js';
import { combinedWalletClient } from './combinedWalletClient.js';
import type { StreamsWalletClient } from './types.js';

export type {
  StreamsWalletAccount,
  StreamsWalletClient,
  StreamsWalletEntry,
  StreamsWalletNetwork,
  StreamsWalletProviderInfo,
  StreamsWalletStatus,
  WalletCapabilities,
  WalletLayer,
} from './types.js';

export { WALLET_LAYER } from './config.js';

export const walletClient: StreamsWalletClient =
  WALLET_LAYER === 'partylayer'
    ? partyLayerWalletClient
    : WALLET_LAYER === 'combined'
      ? combinedWalletClient
      : dappSdkWalletClient;
