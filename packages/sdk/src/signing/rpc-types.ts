/**
 * @module signing/rpc-types
 *
 * RPC type mirrors for the Splice Wallet Gateway dApp API.
 *
 * Shapes verified against `@canton-network/core-wallet-dapp-rpc-client`
 * (May 2026). These mirrors live here so the SDK does not need a hard
 * runtime dependency on the wallet-kernel packages.
 *
 * See `docs/integration-guide/dapp-sdk-types-reference.md` for the
 * verified type listing.
 */

// ---------------------------------------------------------------------------
// Command + ledger primitives
// ---------------------------------------------------------------------------

export interface CreateCommand {
  CreateCommand: { [k: string]: unknown };
}
export interface ExerciseCommand {
  ExerciseCommand: { [k: string]: unknown };
}
export interface CreateAndExerciseCommand {
  CreateAndExerciseCommand: { [k: string]: unknown };
}
export interface ExerciseByKeyCommand {
  ExerciseByKeyCommand: { [k: string]: unknown };
}
export type Command =
  | CreateCommand
  | ExerciseCommand
  | CreateAndExerciseCommand
  | ExerciseByKeyCommand;
export type Commands = Command[];

export type Party = string;
export type ActAs = Party[];
export type ReadAs = Party[];
export type CommandId = string;
export type Message = string;
export type Signature = string;
export type PartyId = string;
export type NetworkId = string;
export type AccessToken = string;
export type UserId = string;

export interface DisclosedContract {
  templateId?: string;
  contractId?: string;
  createdEventBlob: string;
  synchronizerId?: string;
}
export type DisclosedContracts = DisclosedContract[];

// ---------------------------------------------------------------------------
// Method params + results
// ---------------------------------------------------------------------------

export interface PrepareExecuteParams {
  commandId?: CommandId;
  commands: Commands;
  actAs?: ActAs;
  readAs?: ReadAs;
  disclosedContracts?: DisclosedContracts;
  synchronizerId?: string;
  packageIdSelectionPreference?: string[];
}

export interface TxChangedExecutedPayload {
  updateId: string;
  completionOffset: number;
}

export interface TxChangedExecutedEvent {
  status: 'executed';
  commandId: CommandId;
  payload: TxChangedExecutedPayload;
}

export interface PrepareExecuteAndWaitResult {
  tx: TxChangedExecutedEvent;
}

export interface SignMessageParams {
  message: Message;
}

export interface SignMessageResult {
  signature: Signature;
}

export type RequestMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface LedgerApiParams {
  requestMethod: RequestMethod;
  resource: string;
  body?: { [k: string]: unknown };
  query?: { [k: string]: unknown };
  path?: { [k: string]: unknown };
}

export type LedgerApiResult = { [k: string]: unknown };

// ---------------------------------------------------------------------------
// Wallet / account types
// ---------------------------------------------------------------------------

export type WalletStatus = 'initialized' | 'allocated' | 'removed';

export interface Wallet {
  primary: boolean;
  partyId: PartyId;
  status: WalletStatus;
  hint: string;
  publicKey: string;
  namespace: string;
  networkId: NetworkId;
  signingProviderId: string;
  externalTxId?: string;
  topologyTransactions?: string;
  disabled?: boolean;
  reason?: string;
}

export type ListAccountsResult = Wallet[];
export type AccountsChangedEvent = Wallet[];

// ---------------------------------------------------------------------------
// Connection / session types
// ---------------------------------------------------------------------------

export interface ConnectResult {
  isConnected: boolean;
  reason?: string;
  isNetworkConnected: boolean;
  networkReason?: string;
  userUrl?: string;
}

export interface Session {
  accessToken: AccessToken;
  userId: UserId;
}

export interface Network {
  networkId: NetworkId;
  ledgerApi?: string;
  accessToken?: AccessToken;
}

export interface Provider {
  id: string;
  version?: string;
  providerType?: 'browser' | 'desktop' | 'mobile' | 'remote';
  url?: string;
  userUrl?: string;
}

export interface StatusEvent {
  provider: Provider;
  connection: ConnectResult;
  network?: Network;
  session?: Session;
}
