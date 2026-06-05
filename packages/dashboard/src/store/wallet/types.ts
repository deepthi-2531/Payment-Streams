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

/**
 * Entry in a hosted-multi-wallet picker. Returned by
 * `listWallets()` on layers with `capabilities.hostedMultiWallet`.
 * On the partylayer client, each entry maps to a PartyLayer
 * `WalletInfo` (Loop, Console, Cantor8, ...). The dapp-sdk client
 * returns a single synthesised entry for the Amulet gateway it's
 * already pointed at.
 */
export interface StreamsWalletEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** `true` if the underlying adapter detected the wallet is
   * installed / reachable; `false` if it explicitly reported
   * not-installed; `undefined` if the adapter has no opinion. */
  readonly installed?: boolean;
  /** Where to install the wallet if it isn't yet. */
  readonly installUrl?: string;
  /** PartyLayer's CIP-0103-native marker (informational; lets the
   * UI badge "CIP-103 NATIVE" entries). */
  readonly cip0103Native?: boolean;
}

export type StreamsWalletConnectResult = StreamsWalletConnection;
export type StreamsWalletStatusHandler = (event: StreamsWalletStatus) => void;
export type StreamsWalletAccountsHandler = (
  event: readonly StreamsWalletAccount[],
) => void;
export type StreamsWalletTxChangedHandler = (event: unknown) => void;

/**
 * STR-132 capability bag.
 *
 * Each flag tells the dashboard whether a specific Streams flow can
 * be driven through this wallet layer. The optional methods on
 * `StreamsWalletClient` (`ledgerApi`, `prepareExecuteAndWait`) are
 * only safe to call when the matching capability is `true`.
 *
 * Call-sites check capabilities, NOT `typeof client.method === 'function'`:
 * a thrown stub (the PartyLayer unsupported client) defines the
 * method but the capability is `false`. That keeps the gate at the
 * contract, not at the runtime.
 */
export interface WalletCapabilities {
  /** Can issue arbitrary CIP-0103 `ledgerApi` queries against the
   * participant — used to verify on-ledger AllocationRequest /
   * Allocation state. */
  readonly ledgerApi: boolean;
  /** Can call `prepareExecuteAndWait` with a Daml command — required
   * for the future inbox AllocationRequest-accept swap from
   * `walletClient.open()` to a real wallet-signed exercise. */
  readonly prepareExecuteAndWait: boolean;
  /** Wallet renders V2 token-standard AllocationRequest acceptance
   * UX natively (Amulet on the
   * `token-standard-v2-upcoming` branch + the PR canton-network/splice#5697
   * preview do; older builds do not). When false the inbox shows the
   * "open wallet" copy rather than promising in-wallet V2 receiver
   * UX. */
  readonly v2AllocationRequestUx: boolean;
  /** Wallet UI is a hosted multi-wallet picker (PartyLayer) rather
   * than a single-wallet flow (dapp-sdk + a single remote adapter).
   * Drives the connect-flow copy and the inbox no-wallet hint. */
  readonly hostedMultiWallet: boolean;
  /** `dappSDK.open()` brings the wallet UI forward (single-wallet
   * flows) — for hosted multi-wallet flows the picker handles
   * visibility itself. */
  readonly openSurfacesWalletUi: boolean;
}

export interface StreamsWalletClient {
  readonly layer: WalletLayer;
  readonly name: string;

  /** Capability bag for STR-132 gating. Keep this in sync with the
   * concrete methods the layer actually implements; a `false` flag
   * means call-sites MUST NOT invoke the matching method even if it
   * is defined on the object (the unsupported PartyLayer stub
   * defines them but throws). */
  readonly capabilities: WalletCapabilities;

  /** @deprecated Use `capabilities.hostedMultiWallet` instead.
   * Kept for one release so call-sites can migrate without breakage;
   * STR-133 will drop it. */
  readonly supportsHostedMultiWallet: boolean;

  init(): Promise<void>;
  /** When `walletId` is provided and the layer supports it, the
   * layer connects to that specific wallet (PartyLayer adapter id —
   * `loop`, `console`, `cantor8`, ...). When omitted, the layer's
   * native default flow runs (dapp-sdk: auto-remote-picker against
   * the configured gateway; partylayer: prefer-installed if any). */
  connect(walletId?: string): Promise<StreamsWalletConnectResult>;
  disconnect(): Promise<void>;
  status(): Promise<StreamsWalletStatus>;
  listAccounts(): Promise<readonly StreamsWalletAccount[]>;
  /** Only present on hosted-multi-wallet layers
   * (`capabilities.hostedMultiWallet === true`). Returns the
   * adapter list for the dashboard's wallet picker. */
  listWallets?(): Promise<readonly StreamsWalletEntry[]>;
  open(): Promise<void>;

  /** Only call when `capabilities.ledgerApi === true`. */
  ledgerApi?(params: unknown): Promise<unknown>;
  /** Only call when `capabilities.prepareExecuteAndWait === true`. */
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
