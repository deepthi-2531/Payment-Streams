/**
 * Wallet-neutral dashboard contract.
 *
 * Keep this file free of concrete wallet SDK imports. The hosted
 * PartyLayer implementation and the LocalNet dapp-sdk/Amulet
 * implementation should both adapt into this shape.
 */

export type WalletLayer = 'dapp-sdk' | 'partylayer';

export interface StreamsWalletConnection {
  readonly isConnected: boolean;
  readonly isNetworkConnected?: boolean;
  readonly reason?: string | null;
}

export interface StreamsWalletNetwork {
  readonly networkId?: string;
  readonly accessToken?: string;
  readonly ledgerApi?: string;
}

export interface StreamsWalletProviderInfo {
  readonly id?: string;
  readonly name?: string;
  readonly providerType?: string;
}

export interface StreamsWalletSession {
  readonly accessToken?: string;
  readonly userId?: string;
}

export interface StreamsWalletStatus {
  readonly provider?: StreamsWalletProviderInfo | null;
  readonly connection: StreamsWalletConnection;
  readonly network?: StreamsWalletNetwork | null;
  readonly session?: StreamsWalletSession | null;
}

export interface StreamsWalletAccount {
  readonly primary?: boolean;
  readonly partyId: string;
  readonly signingProviderId?: string | null;
}

export type StreamsWalletConnectResult = StreamsWalletConnection;
export type StreamsWalletStatusHandler = (event: StreamsWalletStatus) => void;
export type StreamsWalletAccountsHandler = (
  event: readonly StreamsWalletAccount[],
) => void;
export type StreamsWalletTxChangedHandler = (event: unknown) => void;

export interface StreamsWalletClient {
  readonly layer: WalletLayer;
  readonly name: string;
  readonly supportsHostedMultiWallet: boolean;

  init(): Promise<void>;
  connect(): Promise<StreamsWalletConnectResult>;
  disconnect(): Promise<void>;
  status(): Promise<StreamsWalletStatus>;
  listAccounts(): Promise<readonly StreamsWalletAccount[]>;
  open(): Promise<void>;

  ledgerApi?(params: unknown): Promise<unknown>;
  prepareExecuteAndWait?(params: unknown): Promise<unknown>;

  describeConnectError(err: unknown): Promise<string>;

  onStatusChanged(listener: StreamsWalletStatusHandler): Promise<void>;
  onAccountsChanged(listener: StreamsWalletAccountsHandler): Promise<void>;
  onConnected(listener: StreamsWalletStatusHandler): Promise<void>;
  onTxChanged(listener: StreamsWalletTxChangedHandler): Promise<void>;
  removeOnStatusChanged(listener: StreamsWalletStatusHandler): Promise<void>;
  removeOnAccountsChanged(listener: StreamsWalletAccountsHandler): Promise<void>;
  removeOnConnected(listener: StreamsWalletStatusHandler): Promise<void>;
  removeOnTxChanged(listener: StreamsWalletTxChangedHandler): Promise<void>;
}
