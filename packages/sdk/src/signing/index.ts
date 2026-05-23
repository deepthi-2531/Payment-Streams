/**
 * @module signing
 *
 * Public surface for the SDK's signing provider layer.
 *
 * Most consumers should use:
 *
 *   import { createSigningFromEnv } from '@canton-streams/sdk';
 *
 * For tests + custom wiring, the lower-level pieces are also exported:
 *   - `SigningProvider` / `SigningProviderResolver` interfaces
 *   - `JsonRpcTransport` (rarely needed directly)
 *   - The 5 concrete adapter classes
 *
 * See `docs/integration-guide/wallet-gateway-api-reference.md` for the
 * verified wire contract this layer wraps.
 */

// Interfaces + types
export type {
  SigningProvider,
  SigningProviderResolver,
  SigningProviderKind,
  GatewayConnection,
  SigningErrorCodeValue,
} from './provider.js';
export {
  SigningError,
  SigningErrorCode,
  describeKind,
  isProductionProvider,
} from './provider.js';

// Verified RPC types
export type {
  PrepareExecuteParams,
  PrepareExecuteAndWaitResult,
  SignMessageParams,
  SignMessageResult,
  LedgerApiParams,
  LedgerApiResult,
  Wallet,
  ListAccountsResult,
  Command,
  Commands,
  Party,
  ActAs,
  ReadAs,
} from './rpc-types.js';

// Transport (advanced — most callers don't need this directly)
export { JsonRpcTransport } from './transport.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResponseSuccess,
  JsonRpcResponseError,
} from './transport.js';

// Resolver
export {
  createSigningProviderResolver,
  makeAdapterForKind,
  normalizeSigningProviderId,
} from './resolver.js';
export type { ResolverOptions } from './resolver.js';

// Factory (recommended entry point)
export { createSigningFromEnv, createSigning } from './factory.js';
export type { FactoryResult, FromEnvOptions } from './factory.js';

// Adapter classes (exported for explicit instantiation in tests + advanced wiring)
export { ParticipantSigningProvider } from './adapters/participant.js';
export { FireblocksSigningProvider } from './adapters/fireblocks.js';
export type { FireblocksAdapterOptions } from './adapters/fireblocks.js';
export { BlockdaemonSigningProvider } from './adapters/blockdaemon.js';
export type { BlockdaemonAdapterOptions } from './adapters/blockdaemon.js';
export { DfnsSigningProvider } from './adapters/dfns.js';
export type { DfnsAdapterOptions } from './adapters/dfns.js';
export { WalletGatewayInternalSigningProvider } from './adapters/internal-gateway.js';
export type { InternalGatewayAdapterOptions } from './adapters/internal-gateway.js';
