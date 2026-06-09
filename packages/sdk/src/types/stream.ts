/**
 * @module types/stream
 *
 * Core stream-related types for Canton Payment Streams SDK.
 * All monetary amounts use decimal.js Decimal for arbitrary-precision arithmetic.
 */

import type Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How tokens vest (accrue) over the stream's lifetime. */
export enum VestingMode {
  /** Continuous linear vesting from start to end. */
  Linear = 'Linear',
  /** No vesting until cliff, then linear vesting to end. */
  CliffLinear = 'CliffLinear',
  /** Vesting in discrete equal-sized steps. */
  Stepped = 'Stepped',
  /** Fixed-term stream that can be renewed by the sender. */
  RenewableTerm = 'RenewableTerm',
}

/** Lifecycle status of a payment stream. */
export enum StreamStatus {
  Active = 'Active',
  Completed = 'Completed',
  Cancelled = 'Cancelled',
}

/**
 * Settlement mode — determines how the stream's escrow is backed.
 *
 * New streams are V2-only and must use `TokenStandardCustody`.
 * The other enum values remain so old persisted contracts can be read
 * and migration tools can report them explicitly.
 */
export enum SettlementMode {
  /** Legacy numeric bookkeeping — no real holdings move. */
  NumericLegacy = 'NumericLegacy',
  /** Utility/CIP custody — real holdings locked/split/transferred. */
  UtilityHoldingCustody = 'UtilityHoldingCustody',
  /** CIP-56 V2 / CIP-0112 AllocationRequest custody. */
  TokenStandardCustody = 'TokenStandardCustody',
  /** Host-app local asset custody via a deployment-specific adapter. */
  LocalAssetCustody = 'LocalAssetCustody',
  /** Delegated execution — executor service manages settlement. */
  Delegated = 'Delegated',
}

/**
 * How the stream's escrowed asset should be interpreted by clients and UX.
 *
 * The current on-ledger model still serializes this to the legacy Daml
 * `AssetType` variant, but the SDK exposes the three real product modes:
 *
 *   - validator-local private assets
 *   - CIP-56 tokens on a local/private environment
 *   - CIP-56 tokens with broader/global interoperability
 */
export enum AssetType {
  /** Validator-local private asset holding. */
  ValidatorLocalAsset = 'ValidatorLocalAsset',
  /** CIP-56 token held on a validator-local/private environment. */
  LocalCip56 = 'LocalCip56',
  /** CIP-56 token with broader/global interoperability. */
  GlobalCip56 = 'GlobalCip56',
}

/** Generic JSON-like shape used for account keys and other ledger records. */
export type LedgerRecordValue =
  | string
  | number
  | boolean
  | null
  | readonly LedgerRecordValue[]
  | { readonly [key: string]: LedgerRecordValue };

/** Record payload passed through to the Ledger API for account references. */
export type LedgerRecord = { readonly [key: string]: LedgerRecordValue };

/**
 * Funding details for holding-backed streams.
 *
 * The holding-backed path is the production path for both CIP-56 tokens and
 * any deployment that provides a real local-asset adapter.
 */
export interface HoldingFunding {
  /** Escrow holding to lock for the initial stream deposit. */
  readonly holdingCid?: string;
  /** Sender custody account owning the deposit holding. */
  readonly senderAccount: LedgerRecord;
  /** Recipient account that receives transferred withdrawals. */
  readonly recipientAccount: LedgerRecord;
}

/**
 * Concrete reference to the asset/instrument a stream represents.
 *
 * Mirrors the Daml InstrumentRef type exactly. For LocalToken streams
 * (numeric bookkeeping), instrumentRef is undefined. For LocalHolding
 * and GlobalHolding streams, this identifies the exact Daml Finance
 * instrument being streamed, allowing UIs and operators to distinguish
 * between different assets (e.g. "USD-COIN" vs "ACME-EQUITY").
 *
 * @deprecated for V2 paths. V2 of the CIP-56 token standard collapses
 * the (depository, issuer, instrumentId, instrumentVersion) tuple into
 * a single `InstrumentIdV2 { admin, id }`. New V2-aware code should use
 * `InstrumentIdV2` instead. Use `bridgeInstrumentRefToV2()` to migrate.
 */
export interface InstrumentRef {
  /** Party that hosts the instrument (typically the network operator). */
  readonly depository: string;
  /** Party that issued the instrument (token issuer / asset originator). */
  readonly issuer: string;
  /** Unique identifier for the instrument (e.g. "USD-COIN", "ACME-EQUITY"). */
  readonly instrumentId: string;
  /** Version tag for the instrument (e.g. "1.0", "2024-Q1"). */
  readonly instrumentVersion: string;
}

/**
 * V2 InstrumentId — the addressing primitive used by the CIP-56 V2 token
 * standard. Mirrors `Splice.Api.Token.HoldingV2.InstrumentId`. Replaces
 * `InstrumentRef` for V2-aware code.
 */
export interface InstrumentIdV2 {
  /** Registry app administering the instrument. */
  readonly admin: string;
  /** Unique identifier per instrument admin. */
  readonly id: string;
}

/**
 * V2 Account — addressing primitive for sender / recipient on V2 paths.
 * Mirrors `Splice.Api.Token.HoldingV2.Account`. The `provider` field
 * identifies the custodian / service provider with visibility on
 * movements; for institutional flows this should be supplied.
 */
export interface AccountV2 {
  readonly owner: string;
  readonly provider?: string;
  readonly id: string;
}

/**
 * Migration bridge from V1 InstrumentRef to V2 InstrumentIdV2. The
 * depository and instrumentVersion fields are dropped because V2 has
 * no equivalent. The issuer maps to V2's `admin` because that matches
 * the V2 semantics (the registry app administering the instrument).
 *
 * Mirrors `bridgeInstrumentRefToV2` in the Daml interfaces package.
 */
export function bridgeInstrumentRefToV2(ref: InstrumentRef): InstrumentIdV2 {
  return {
    admin: ref.issuer,
    id: ref.instrumentId,
  };
}

/**
 * Build a V2 Account from a bare party identifier (the V1 addressing
 * model). The provider field is left undefined; institutional callers
 * should supply a provider party for custodian visibility.
 */
export function bridgeAccountFromParty(owner: string): AccountV2 {
  return { owner, id: '' };
}

// ---------------------------------------------------------------------------
// Custody references (live on request/escrow, NOT StreamConfig)
// ---------------------------------------------------------------------------

/**
 * Reference to the escrow operator service account.
 * Lives on request and escrow contracts, not on StreamConfig.
 */
export interface EscrowOperatorRef {
  /** Canton party ID of the escrow operator. */
  readonly operator: string;
  /** Human-readable label for display (e.g. "Canton Escrow Service"). */
  readonly operatorLabel: string;
}

/**
 * Funding reference — identifies the source holding for escrow creation.
 * Lives on CreateUtilityHoldingStreamRequest / CreateLocalAssetStreamRequest.
 * Not part of StreamConfig (which is immutable business config).
 */
export interface FundingRef {
  /** Contract ID of the source holding to lock/split for escrow. */
  readonly holdingCid: string;
  /** Generic sender-side funding reference used by token-standard custody. */
  readonly fundingReference?: string;
  /** Amount to carve from the source holding. */
  readonly depositAmount: string;
  /** Instrument being streamed. */
  readonly instrumentRef: InstrumentRef;
  /** Sender custody account owning the source holding. */
  readonly senderAccount: LedgerRecord;
  /** Recipient account for withdrawal transfers. */
  readonly recipientAccount: LedgerRecord;
}

/**
 * Escrow reference — identifies the custody-held escrow on an active stream.
 * Populated by query deserialization from the active escrow contract.
 * Lives on the Stream runtime type, not on StreamConfig.
 */
export interface EscrowRef {
  /** Escrow reference (holding CID for direct custody, external ref for token-standard custody). */
  readonly escrowHoldingCid: string;
  /** Current escrow amount (may differ from totalDeposited after partial withdrawals). */
  readonly escrowAmount: string;
  /** Escrow operator party. */
  readonly escrowOperator: string;
  /** Instrument reference for the escrowed asset. */
  readonly instrumentRef: InstrumentRef;
  /** Recipient account for withdrawal transfers. */
  readonly recipientAccount: LedgerRecord;
  /** Utility/local custody operator party on the underlying holding. */
  readonly operator?: string;
  /** Utility/local custody provider / depository host party. */
  readonly provider?: string;
  /** Utility/local custody registrar / issuer party. */
  readonly registrar?: string;
  /** Current owner of the underlying escrow holding. */
  readonly owner?: string;
  /** Label carried by the underlying holding. */
  readonly label?: string;
  /** Sender-side funding reference recorded for token-standard custody. */
  readonly fundingReference?: string;
  /** Latest external settlement reference recorded on the stream. */
  readonly lastSettlementReference?: string;
  /** Serialized sender account/wallet reference for token-standard flows. */
  readonly senderAccountRef?: string;
  /** Serialized recipient account/wallet reference for token-standard flows. */
  readonly recipientAccountRef?: string;
}

// ---------------------------------------------------------------------------
// Vesting mode configurations (discriminated union)
// ---------------------------------------------------------------------------

/** Configuration for linear vesting. */
export interface LinearVestingConfig {
  readonly mode: VestingMode.Linear;
}

/**
 * Configuration for cliff-then-linear vesting.
 * Matches Daml: `CliffLinear with cliffTime : Time`
 *
 * Zero accrual until cliffTime, then the full linear curve from
 * startTime→endTime becomes available (i.e. at cliff, all accrued-so-far
 * unlocks at once, then continues linearly to endTime).
 */
export interface CliffLinearVestingConfig {
  readonly mode: VestingMode.CliffLinear;
  /** Time at which the cliff releases. Must be between startTime and endTime. */
  readonly cliffTime: Date;
}

/**
 * Configuration for stepped (discrete) vesting.
 * Matches Daml: `Stepped with stepInterval : RelTime; amountPerStep : Decimal`
 *
 * Fixed amount unlocked at regular intervals.
 * Accrual = min(deposit, floor(elapsed / stepInterval) * amountPerStep)
 */
export interface SteppedVestingConfig {
  readonly mode: VestingMode.Stepped;
  /** Interval between steps in microseconds (matches Daml RelTime). */
  readonly stepInterval: number;
  /** Fixed amount unlocked per step. */
  readonly amountPerStep: Decimal;
}

/**
 * Configuration for renewable fixed-term streams.
 * Matches Daml: `RenewableTerm with termDuration : RelTime`
 *
 * Fixed-duration stream that can be renewed/topped up before expiry.
 * Accrual follows linear within each term.
 */
export interface RenewableTermVestingConfig {
  readonly mode: VestingMode.RenewableTerm;
  /** Duration of each term in microseconds (matches Daml RelTime). */
  readonly termDuration: number;
}

/**
 * Discriminated union of all vesting mode configurations.
 * Switch on `mode` to narrow the type.
 */
export type VestingModeConfig =
  | LinearVestingConfig
  | CliffLinearVestingConfig
  | SteppedVestingConfig
  | RenewableTermVestingConfig;

// ---------------------------------------------------------------------------
// Stream structures
// ---------------------------------------------------------------------------

/** Immutable configuration set at stream creation time. */
export interface StreamConfig {
  /** Unique identifier for this stream. */
  readonly streamId: string;
  /** Canton party that funds the stream. */
  readonly sender: string;
  /** Canton party that receives the streamed funds. */
  readonly recipient: string;
  /** Total amount deposited into the stream. */
  readonly totalDeposited: Decimal;
  /** When vesting begins (inclusive). */
  readonly startTime: Date;
  /** When vesting ends (inclusive). */
  readonly endTime: Date;
  /** Vesting schedule configuration. */
  readonly vestingMode: VestingModeConfig;
  /** How the escrowed asset should be treated by clients and operators. */
  readonly assetType: AssetType;
  /**
   * Concrete asset/instrument this stream represents.
   * Undefined for LocalToken streams (numeric bookkeeping).
   * For holding-backed streams, identifies the exact Daml Finance instrument.
   */
  readonly instrumentRef?: InstrumentRef;
  /** Whether the sender may cancel this stream before completion. */
  readonly cancellable: boolean;
  /**
   * Settlement mode. New streams default to TokenStandardCustody; legacy
   * modes are read-only compatibility labels.
   */
  readonly settlementMode?: SettlementMode;
}

/** Mutable runtime state of a stream, updated by ledger events. */
export interface StreamState {
  /** Cumulative amount withdrawn by the recipient so far. */
  readonly totalWithdrawn: Decimal;
  /** Current lifecycle status. */
  readonly status: StreamStatus;
  /** Timestamp of the most recent withdrawal, if any. */
  readonly lastWithdrawTime?: Date;
  /** Number of times this stream has been renewed (RenewableTerm only). */
  readonly renewalCount: number;
}

/** A fully-hydrated stream combining its contract ID, config, and state. */
export interface Stream {
  /** Canton ledger contract ID. */
  readonly contractId: string;
  /** Immutable stream configuration. */
  readonly config: StreamConfig;
  /** Mutable stream state. */
  readonly state: StreamState;
  /**
   * Escrow custody reference — present for holding-backed streams.
   * Populated by query deserialization from the active escrow contract payload.
   * Undefined for NumericLegacy streams.
   */
  readonly escrowRef?: EscrowRef;
}

/** Pre-activation stream request awaiting the required wallet/token-standard approval. */
export interface PendingStreamRequest {
  /** Canton ledger contract ID of the CreateStreamRequest. */
  readonly contractId: string;
  /** Requested stream configuration. */
  readonly config: StreamConfig;
  /** Intended recipient account for withdrawal settlement. */
  readonly recipientAccount?: LedgerRecord;
  /** Additional observer parties on the request. */
  readonly observers: readonly string[];
  /** Funding reference for custody-backed requests. */
  readonly fundingRef?: FundingRef;
  /** Settlement mode of this request. */
  readonly settlementMode: SettlementMode;
  /** Funding holding reference for custody-backed requests. */
  readonly fundingHoldingCid?: string;
  /** Generic funding reference for token-standard custody requests. */
  readonly fundingReference?: string;
  /** Escrow operator party for custody-backed requests. */
  readonly escrowOperator?: string;
}

// ---------------------------------------------------------------------------
// Balances (display-only computation)
// ---------------------------------------------------------------------------

/**
 * Point-in-time balance snapshot for a stream.
 * All values are DISPLAY-ONLY approximations; the ledger is authoritative.
 */
export interface StreamBalances {
  /** Total amount that has accrued (vested) up to `now`. */
  readonly accrued: Decimal;
  /** Amount available for the recipient to withdraw right now (accrued - already withdrawn). */
  readonly withdrawable: Decimal;
  /** Amount the sender would receive back if the stream were cancelled now. */
  readonly refundable: Decimal;
  /** Cumulative amount already withdrawn by the recipient. */
  readonly alreadyWithdrawn: Decimal;
  /** Percentage of the stream that has vested, 0–100. */
  readonly percentComplete: number;
}

// ---------------------------------------------------------------------------
// Params & results
// ---------------------------------------------------------------------------

/** Parameters for creating a single payment stream. */
export interface CreateStreamParams {
  /** Unique identifier for the new stream. */
  readonly streamId: string;
  /** Canton party funding the stream. */
  readonly sender: string;
  /** Canton party receiving streamed funds. */
  readonly recipient: string;
  /** Total amount to deposit. Must be > 0. */
  readonly totalDeposited: Decimal;
  /** When vesting begins. */
  readonly startTime: Date;
  /** When vesting ends. Must be after startTime. */
  readonly endTime: Date;
  /** Vesting schedule to use. */
  readonly vestingMode: VestingModeConfig;
  /** Asset integration mode. Defaults to global CIP-56. */
  readonly assetType?: AssetType;
  /** Concrete instrument reference. Required for holding-backed streams. */
  readonly instrumentRef?: InstrumentRef;
  /** Holding CID for deposit. Required for holding-backed escrow. */
  readonly holdingCid?: string;
  /** Generic sender-side funding reference for token-standard custody. */
  readonly fundingReference?: string;
  /** Sender custody account. Required for holding-backed escrow. */
  readonly senderAccount?: LedgerRecord;
  /** Recipient account for withdrawals. Required for holding-backed escrow. */
  readonly recipientAccount?: LedgerRecord;
  /** Whether the sender may cancel the stream. */
  readonly cancellable: boolean;
  /**
   * Settlement mode for the new stream. Defaults to TokenStandardCustody.
   * Non-token-standard modes are rejected for new stream creation.
   */
  readonly settlementMode?: SettlementMode;
  /** Escrow operator party. Required for holding-backed settlement modes. */
  readonly escrowOperator?: string;
  /** Escrow operator's custody account. Retained for legacy custody reads. */
  readonly escrowAccount?: LedgerRecord;
}

/** Parameters for creating multiple streams in a single ledger transaction. */
export interface CreateBatchParams {
  /** Streams to create atomically. */
  readonly streams: readonly CreateStreamParams[];
}

/** Optional funding-confirmation payload for custody finalization. */
export interface FinalizeEscrowParams {
  /** External escrow reference or custody account that received the funding. */
  readonly escrowReference?: string;
  /** Transfer / settlement reference proving the sender -> escrow movement. */
  readonly settlementReference?: string;
  /** Confirmed amount now available in escrow. */
  readonly confirmedEscrowAmount?: Decimal;
}

/** Confirmation payload for recording a token-standard withdrawal. */
export interface TokenStandardWithdrawParams {
  /** External transfer reference for the escrow -> recipient payout. */
  readonly settlementReference: string;
  /** Amount actually settled to the recipient. */
  readonly settledAmount: Decimal;
  /**
   * Explicit withdraw timestamp (microseconds precision).
   * When supplied, the SDK uses this instead of Date.now() so that the
   * caller can compute settledAmount against the exact same moment.
   */
  readonly withdrawTime?: Date;
}

/** Confirmation payload for recording a token-standard cancellation. */
export interface TokenStandardCancelParams {
  /** Optional transfer reference for the recipient payout leg. */
  readonly recipientSettlementReference?: string;
  /** Optional transfer reference for the sender refund leg. */
  readonly senderRefundReference?: string;
  /** Amount actually paid to the recipient. */
  readonly recipientAmountSettled: Decimal;
  /** Amount actually refunded to the sender. */
  readonly senderRefundSettled: Decimal;
  /**
   * Explicit cancel timestamp. When supplied, the SDK uses this instead of
   * Date.now() so that the caller can compute recipientAmountSettled and
   * senderRefundSettled against the exact same moment that Daml will verify.
   * Must match the time used for computing recipientAmountSettled / senderRefundSettled.
   */
  readonly cancelTime?: Date;
}

/** Result of a successful withdrawal from a stream. */
export interface WithdrawResult {
  /** Amount actually withdrawn in this transaction. */
  readonly amountWithdrawn: Decimal;
  /** Cumulative withdrawn amount after this withdrawal. */
  readonly newTotalWithdrawn: Decimal;
  /** Lifecycle status after the withdrawal. */
  readonly newStatus: StreamStatus;
}

/** Result of cancelling a stream. */
export interface CancelResult {
  /** Amount released to the recipient for vested-but-unwithdrawn funds. */
  readonly recipientAmount: Decimal;
  /** Amount refunded to the sender. */
  readonly senderRefund: Decimal;
}

/** Parameters for renewing a RenewableTerm stream. */
export interface RenewParams {
  /** Additional amount to deposit for the new term. Must be > 0. */
  readonly additionalAmount: Decimal;
  /** New end time for the renewed term. Must be in the future. */
  readonly newEndTime: Date;
  /** Holding to merge into the existing escrow (direct-custody modes only). */
  readonly holdingCid: string;
  /** Sender custody account owning the top-up holding (legacy/account-based integrations only). */
  readonly senderAccount?: LedgerRecord;
  /** Sender-side funding reference for token-standard top-ups. */
  readonly fundingReference?: string;
  /** External settlement reference confirming the top-up reached escrow. */
  readonly settlementReference?: string;
  /** Amount actually confirmed into escrow for token-standard renewal. */
  readonly confirmedAdditionalAmount?: Decimal;
}

// ---------------------------------------------------------------------------
// Queries & events
// ---------------------------------------------------------------------------

/** Filter criteria for querying streams. */
export interface StreamFilter {
  /** Filter by sender party. */
  readonly sender?: string;
  /** Filter by recipient party. */
  readonly recipient?: string;
  /** Filter by stream status. */
  readonly status?: StreamStatus;
  /** Filter by vesting mode. */
  readonly vestingMode?: VestingMode;
  /** Filter by settlement mode. */
  readonly settlementMode?: SettlementMode;
}

/** Filter criteria for pending stream requests. */
export interface PendingStreamRequestFilter {
  /** Filter by sender party. */
  readonly sender?: string;
  /** Filter by recipient party. */
  readonly recipient?: string;
  /** Filter by asset mode. */
  readonly assetType?: AssetType;
}

/** Types of stream lifecycle events. */
export type StreamEventType = 'created' | 'withdrawn' | 'cancelled' | 'completed' | 'renewed';

/**
 * Where the event data came from.
 *
 * - `'ledger'` — authoritative, from UpdateService transaction stream
 * - `'state'`  — approximate, synthesized from current contract state
 */
export type StreamEventSource = 'ledger' | 'state';

/** A discrete event that occurred on a stream. */
export interface StreamEvent {
  /** Type of event. */
  readonly type: StreamEventType;
  /** Contract ID of the affected stream. */
  readonly contractId: string;
  /** Ledger effective time of the event. */
  readonly timestamp: Date;
  /** Where the event data came from. */
  readonly source?: StreamEventSource;
  /** Event-specific payload. */
  readonly payload: Record<string, unknown>;
}

/** Notification of a stream state change, delivered by subscriptions. */
export interface StreamUpdate {
  /** The event that triggered this update. */
  readonly event: StreamEvent;
  /** The full stream state after the event, if still active. */
  readonly stream?: Stream;
}
