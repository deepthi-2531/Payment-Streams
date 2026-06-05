import { WALLET_LAYER } from './config.js';
import { dappSdkWalletClient } from './dappSdkClient.js';
import { unsupportedPartyLayerClient } from './unsupportedPartyLayerClient.js';
import type { StreamsWalletClient } from './types.js';

export type {
  StreamsWalletAccount,
  StreamsWalletClient,
  StreamsWalletNetwork,
  StreamsWalletProviderInfo,
  StreamsWalletStatus,
  WalletLayer,
} from './types.js';

export { WALLET_LAYER } from './config.js';

export const walletClient: StreamsWalletClient =
  WALLET_LAYER === 'partylayer'
    ? unsupportedPartyLayerClient
    : dappSdkWalletClient;
