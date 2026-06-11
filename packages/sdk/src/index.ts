/**
 * @canton-streams/sdk
 *
 * TypeScript SDK for Canton Payment Streams.
 * gRPC-first continuous payment streaming for Canton.
 *
 * @license Apache-2.0
 */

export { CantonStreamsClient } from './client.js';
export type { ClientConfig } from './types/config.js';
export type {
  Stream,
  StreamConfig,
  StreamState,
  StreamBalances,
  LedgerRecord,
  LedgerRecordValue,
  HoldingFunding,
  InstrumentRef,
  EscrowOperatorRef,
  FundingRef,
  EscrowRef,
  VestingModeConfig,
  CreateStreamParams,
  CreateBatchParams,
  FinalizeEscrowParams,
  TokenStandardWithdrawParams,
  TokenStandardCancelParams,
  WithdrawResult,
  CancelResult,
  RenewParams,
  StreamFilter,
  PendingStreamRequest,
  PendingStreamRequestFilter,
  StreamEvent,
  StreamEventSource,
  StreamUpdate,
} from './types/stream.js';
export { VestingMode, StreamStatus, AssetType, SettlementMode } from './types/stream.js';
export {
  TEMPLATE_CREATE_REQUEST,
  TEMPLATE_BATCH_REQUEST,
  TEMPLATE_STREAM_ESCROW,
  TEMPLATE_UTILITY_CREATE_REQUEST,
  TEMPLATE_UTILITY_ACCEPTED_REQUEST,
  TEMPLATE_UTILITY_ESCROW,
  TEMPLATE_TOKEN_STANDARD_CREATE_REQUEST,
  TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
  TEMPLATE_TOKEN_STANDARD_ESCROW,
  TEMPLATE_LOCAL_ASSET_CREATE_REQUEST,
  TEMPLATE_LOCAL_ASSET_ACCEPTED_REQUEST,
  TEMPLATE_LOCAL_ASSET_ESCROW,
  TEMPLATE_DELEGATED_POLICY,
  TEMPLATE_EXECUTION_LOG,
  CHOICE_ACCEPT_STREAM,
  CHOICE_DECLINE_STREAM,
  CHOICE_WITHDRAW_REQUEST,
  CHOICE_WITHDRAW_STREAM,
  CHOICE_CANCEL_STREAM,
  CHOICE_MUTUAL_CANCEL_STREAM,
  CHOICE_RENEW_STREAM,
  CHOICE_COMPLETE_STREAM,
  CHOICE_ACCEPT_UTILITY_REQUEST,
  CHOICE_FINALIZE_UTILITY_ESCROW,
  CHOICE_ACCEPT_TOKEN_STANDARD_REQUEST,
  CHOICE_FINALIZE_TOKEN_STANDARD_ESCROW,
  CHOICE_WITHDRAW_UTILITY,
  CHOICE_CANCEL_UTILITY,
  CHOICE_MUTUAL_CANCEL_UTILITY,
  CHOICE_RENEW_UTILITY,
  CHOICE_WITHDRAW_TOKEN_STANDARD,
  CHOICE_CANCEL_TOKEN_STANDARD,
  CHOICE_MUTUAL_CANCEL_TOKEN_STANDARD,
  CHOICE_RENEW_TOKEN_STANDARD,
  CHOICE_ACCEPT_LOCAL_ASSET_REQUEST,
  CHOICE_FINALIZE_LOCAL_ASSET_ESCROW,
  CHOICE_WITHDRAW_LOCAL_ASSET,
  CHOICE_CANCEL_LOCAL_ASSET,
  CHOICE_MUTUAL_CANCEL_LOCAL_ASSET,
  CHOICE_RENEW_LOCAL_ASSET,
  CHOICE_EXECUTE_POLICY,
  CHOICE_REVOKE_POLICY,
  TEMPLATE_STREAM_FLOW,
  CHOICE_TOP_UP_FLOW,
  CHOICE_WITHDRAW_FLOW,
  CHOICE_PAUSE_FLOW,
  CHOICE_RESUME_FLOW,
  CHOICE_STOP_FLOW,
  CHOICE_GET_FLOW_INFO,
  ESCROW_TEMPLATES,
  CREATE_REQUEST_TEMPLATES,
  validateTemplateRegistry,
} from './templates.js';
export { BalanceTicker } from './accrual/ticker.js';
export {
  SettlementOrchestrator,
  createDefaultOrchestrator,
} from './settlement/orchestrator.js';
export type {
  OrchestratedFinalizeResult,
  OrchestratedWithdrawResult,
  OrchestratedCancelResult,
  OrchestratedRenewResult,
} from './settlement/orchestrator.js';
export type { SettlementAdapter, TransferParams, TransferResult } from './settlement/adapter.js';
export { AmuletWalletGatewayAdapter } from './settlement/adapters/amulet.js';
export { TransferRuleAdapter } from './settlement/adapters/transfer-rule.js';
export { TransferOfferAdapter } from './settlement/adapters/transfer-offer.js';
export {
  linearAccrual,
  cliffLinearAccrual,
  steppedAccrual,
  getBalances,
} from './accrual/calculator.js';
export {
  CantonStreamsError,
  TransportError,
  ValidationError,
  LedgerError,
  InvariantViolationError,
} from './utils/errors.js';
export { GrpcTransport } from './transport/grpc.js';
export { JsonApiTransport, JsonApiError } from './transport/json-api.js';
export type { JsonApiConfig } from './transport/json-api.js';
export type { Transport, CreateResult, TemplateId } from './transport/base.js';
export { withRetry } from './transport/retry.js';
export type { RetryOptions } from './transport/retry.js';
export { validate, CreateStreamParamsSchema, RenewParamsSchema, StreamFilterSchema } from './utils/validation.js';
export { createLogger, setLogLevel } from './utils/logger.js';
export type { PolicyInfo, ExecutionLogInfo } from './commands/policy.js';

// SigningProvider — wallet-gateway-bound per-party signing for
// server-side automation. Replaces the in-process node:crypto path.
// Uses the CIP-103 JSON-RPC dApp API exposed by the configured wallet gateway.
export {
  createSigningFromEnv,
  createSigning,
  createSigningProviderResolver,
  JsonRpcTransport,
  SigningError,
  SigningErrorCode,
  ParticipantSigningProvider,
  FireblocksSigningProvider,
  BlockdaemonSigningProvider,
  DfnsSigningProvider,
  WalletGatewayInternalSigningProvider,
  describeKind as describeSigningProviderKind,
  isProductionProvider,
  normalizeSigningProviderId,
  makeAdapterForKind,
} from './signing/index.js';
export type {
  SigningProvider,
  SigningProviderResolver,
  SigningProviderKind,
  GatewayConnection,
  SigningErrorCodeValue,
  ResolverOptions as SigningResolverOptions,
  FactoryResult as SigningFactoryResult,
  FromEnvOptions as SigningFromEnvOptions,
  PrepareExecuteParams as GatewayPrepareExecuteParams,
  PrepareExecuteAndWaitResult as GatewayPrepareExecuteAndWaitResult,
  SignMessageParams as GatewaySignMessageParams,
  SignMessageResult as GatewaySignMessageResult,
  LedgerApiParams as GatewayLedgerApiParams,
  LedgerApiResult as GatewayLedgerApiResult,
  Wallet as GatewayWallet,
  ListAccountsResult as GatewayListAccountsResult,
} from './signing/index.js';

// Settlement dispatchers. V2 (`dispatchSettlement`) is the preferred
// lane for assets advertising V2 allocation support; V1
// (`dispatchSettlementV1`) is the transitional lane for MainNet-live
// assets (CC / Amulet, USDCx) that have not yet published V2 interfaces.
// Resolve the lane once via `resolveSettlementVersion(caps)`. The V1
// lane is deprecated from birth and is removed once the reference
// assets advertise V2.
export {
  dispatchSettlement,
  dispatchSettlementV1,
  resolveSettlementVersion,
  buildWithdrawalSettleCommand,
  buildWithdrawalRequestCommand,
} from './settlement/allocation-dispatch.js';
export type {
  DispatchAction,
  DispatchCommand,
  DispatchResult,
  EmitRequestCommand,
  SettleCommand,
  CancelCommand,
  BatchSettleCommand,
  DispatchActionV1,
  DispatchCommandV1,
  DispatchResultV1,
  EmitRequestV1Command,
  SettleV1Command,
  CancelV1Command,
  WithdrawV1Command,
  SettlementApiVersion,
} from './settlement/allocation-dispatch.js';

// AllocationRequestV2 emission + Allocation_Settle dispatch.
// The escrow templates (StreamEscrow, StreamFlow, MilestoneEscrow) implement
// AllocationRequestV2 per CIP-0112 §5. This module is the SDK-side surface
// for emitting and settling V2 Allocation contracts.
export {
  buildAllocationRequest,
  buildAllocationSettle,
  buildAllocationCancel,
  buildBatchSettlement,
} from './commands/allocation.js';
export type {
  AllocationRequestPayload,
  BuildAllocationRequestParams,
  AllocationSettlementInfo,
  TransferLegV2,
  InstrumentIdV2,
  AccountV2,
  NextIterationFunding,
  AllocationMetadata,
  AllocationView,
} from './commands/allocation.js';

// CIP-56 V1 lane builders (transitional — see commands/allocation-v1.ts
// for the removal plan). Self-contained so the lane deletes cleanly.
export {
  buildAllocationRequestV1,
  buildAllocationExecuteTransferV1,
  buildAllocationCancelV1,
  buildAllocationWithdrawV1,
  META_KEY_STREAMS_REF,
  META_KEY_STREAMS_VERSION,
  META_KEY_STREAMS_APP,
  META_STREAMS_VERSION,
} from './commands/allocation-v1.js';

// Registry choice-context fetcher for the V1 lane (Amulet: served by
// Scan). Deleted together with the lane.
export {
  fetchAllocationChoiceContext,
  fetchAllocationFactory,
  RegistryApiError,
} from './settlement/choice-context.js';
export type {
  AllocationChoiceContextAction,
  FetchChoiceContextParams,
  AllocationFactoryRequest,
  AllocationFactoryResult,
} from './settlement/choice-context.js';
export type { DisclosedContract, CommandOptions } from './transport/base.js';
export type {
  AllocationRequestV1Payload,
  BuildAllocationRequestV1Params,
  SettlementInfoV1,
  TransferLegV1,
  InstrumentIdV1,
  ChoiceContextV1,
  AllocationMetadataV1,
} from './commands/allocation-v1.js';

// StreamFlow — non-prefunded / rolling top-up open-ended streaming.
// Sender maintains a funded balance via TopUp_Flow; withdrawals are
// bounded by the funded balance. Settlement is V2 iterated allocation.
export {
  buildFlowCreate,
  buildTopUpFlow,
  buildWithdrawFlow,
  buildPauseFlow,
  buildResumeFlow,
  buildStopFlow,
  createFlow,
  topUpFlow,
  withdrawFlow,
  pauseFlow,
  resumeFlow,
  stopFlow,
  listFlows,
  getFlow,
} from './commands/flow.js';
export type {
  CreateFlowParams,
  FlowCreatePayload,
  FlowExercisePayload,
  TopUpFlowParams,
  WithdrawFlowParams,
  PauseFlowParams,
  ResumeFlowParams,
  StopFlowParams,
  FlowInfo,
  FlowFilter,
  FlowStatus,
} from './commands/flow.js';

// StreamAdmin orchestration — admin/observability surface for V2
// iterated-allocation streaming. Records per-stream metadata + pointers
// to the active V2 Allocation cid; lifecycle proper lives in
// the V2 Allocation contracts driven by `commands/allocation`.
export {
  buildStreamAdminCreate,
  buildSyncIteration,
  buildMarkCancelled,
  buildMarkCompleted,
} from './commands/stream-admin.js';
export type {
  CreateStreamAdminParams,
  StreamAdminCreatePayload,
  SyncIterationParams,
  MarkCancelledParams,
  MarkCompletedParams,
  VestingMode as StreamAdminVestingMode,
  InstrumentRefSdk,
} from './commands/stream-admin.js';

// Transitional CIP-0047 featured-app marker emission (opt-in).
export {
  disabledFeaturedApp,
  enabledFeaturedApp,
  buildEmission,
  estimateRewardCapUsd,
} from './featured-app.js';
export type {
  ActivityType,
  FeaturedAppConfig,
  FeaturedAppEmission,
  FeaturedAppRewardEstimateOptions,
} from './featured-app.js';

// Use-case facades — vesting, LP incentives, validator billing.
// Also published as the `@canton-streams/sdk/helpers` subpath.
export {
  buildVestingStream,
  buildIncentiveStream,
  buildRecurringBillingStream,
  buildUsageBillingFlow,
} from './helpers/index.js';
export type {
  VestingStreamOptions,
  VestingStyle,
  IncentiveStreamOptions,
  RecurringBillingOptions,
  UsageBillingFlowOptions,
  FlowCreateParams,
} from './helpers/index.js';
