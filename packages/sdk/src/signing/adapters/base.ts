/**
 * @module signing/adapters/base
 *
 * Shared base class for all 5 SigningProvider adapters. All providers
 * use the same JSON-RPC 2.0 wire (the gateway routes internally to
 * the bound signing provider); the per-adapter classes differ in:
 *
 *   - `kind` tag (for observability / logs)
 *   - Provider-specific error code mapping at the JSON-RPC `error.data` layer
 *   - Provider-specific config validation (e.g. ensuring required env
 *     vars are present at startup so failures surface at init time, not
 *     at first call)
 */

import { JsonRpcTransport } from '../transport.js';
import type {
  SigningProvider,
  SigningProviderKind,
  GatewayConnection,
} from '../provider.js';
import type {
  LedgerApiParams,
  LedgerApiResult,
  ListAccountsResult,
  PrepareExecuteAndWaitResult,
  PrepareExecuteParams,
  SignMessageParams,
  SignMessageResult,
} from '../rpc-types.js';

/** Base implementation; subclasses set the `kind` + may override hooks. */
export abstract class BaseSigningProvider implements SigningProvider {
  abstract readonly kind: SigningProviderKind;
  readonly connection: GatewayConnection;
  // Lazy: built on first use so we can read `this.kind` after the
  // subclass field initializer has run. (TS forbids using `this.kind`
  // in the base constructor because the abstract field isn't bound yet.)
  private _transport: JsonRpcTransport | undefined;
  protected get transport(): JsonRpcTransport {
    if (!this._transport) {
      this._transport = new JsonRpcTransport(this.connection, this.kind);
    }
    return this._transport;
  }

  constructor(connection: GatewayConnection) {
    this.connection = connection;
  }

  async prepareExecute(params: PrepareExecuteParams): Promise<null> {
    return this.transport.request<null>('prepareExecute', params);
  }

  async prepareExecuteAndWait(
    params: PrepareExecuteParams,
  ): Promise<PrepareExecuteAndWaitResult> {
    return this.transport.request<PrepareExecuteAndWaitResult>(
      'prepareExecuteAndWait',
      params,
    );
  }

  async signMessage(params: SignMessageParams): Promise<SignMessageResult> {
    return this.transport.request<SignMessageResult>('signMessage', params);
  }

  async ledgerApi(params: LedgerApiParams): Promise<LedgerApiResult> {
    return this.transport.request<LedgerApiResult>('ledgerApi', params);
  }

  async listAccounts(): Promise<ListAccountsResult> {
    return this.transport.request<ListAccountsResult>('listAccounts');
  }
}
