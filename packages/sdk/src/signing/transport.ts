/**
 * @module signing/transport
 *
 * JSON-RPC 2.0 transport for the Splice Wallet Gateway dApp API.
 *
 * Shared by all 5 `SigningProvider` adapters (Participant / Fireblocks /
 * Blockdaemon / Dfns / WalletGatewayInternal). The gateway exposes
 * JSON-RPC 2.0 at `/api/v0/dapp`; this transport handles:
 *
 *   * Request id correlation
 *   * Batch requests
 *   * JSON-RPC error envelope → `SigningError` mapping (EIP-1474 codes)
 *   * Authorization header injection
 *   * Timeout + abort
 *
 * The transport is intentionally separate from the per-adapter
 * concerns so wire-level fixes land once.
 *
 * The shape mirrors `@canton-network/core-rpc-transport` (verified May
 * 2026) — we don't depend on that package directly so this SDK can be
 * consumed in environments without the wallet-kernel chain installed,
 * but the wire contract is identical.
 */

import {
  SigningError,
  SigningErrorCode,
  type GatewayConnection,
  type SigningProviderKind,
} from './provider.js';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: P;
}

export interface JsonRpcResponseSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result: R;
}

export interface JsonRpcResponseError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcResponseSuccess<R>
  | JsonRpcResponseError;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Default timeout for a single JSON-RPC call (ms). Per-call overrides
 * via `JsonRpcTransport.request(..., { timeoutMs })`.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal JSON-RPC 2.0 client against the Wallet Gateway. Each
 * SigningProvider adapter holds one of these and delegates method
 * calls.
 */
export class JsonRpcTransport {
  private nextId = 1;

  constructor(
    private readonly connection: GatewayConnection,
    /**
     * Optional kind tag — propagated into SigningError.kind on failures
     * so logs show which provider's wire call failed.
     */
    private readonly kind?: SigningProviderKind,
  ) {}

  /**
   * Send a single JSON-RPC request. Resolves with the `result` field
   * on success; rejects with `SigningError` on JSON-RPC error or
   * HTTP failure.
   *
   * @param method  JSON-RPC method name (e.g. `prepareExecute`)
   * @param params  Method params per the OpenRPC spec
   * @param opts    Per-call overrides
   */
  async request<R = unknown, P = unknown>(
    method: string,
    params?: P,
    opts?: { readonly timeoutMs?: number },
  ): Promise<R> {
    const id = this.nextId++;
    const body: JsonRpcRequest<P> = {
      jsonrpc: '2.0',
      id,
      method,
    };
    if (params !== undefined) body.params = params;

    const res = await this.sendRaw([body], opts?.timeoutMs);
    const responses = res as JsonRpcResponse<R>[];
    if (responses.length !== 1) {
      throw new SigningError({
        code: SigningErrorCode.INTERNAL_ERROR,
        message: `JSON-RPC expected 1 response, got ${responses.length}`,
        kind: this.kind,
      });
    }
    return this.unwrapResponse<R>(responses[0]!);
  }

  /**
   * Send a batch of JSON-RPC requests. The gateway returns an array
   * of responses, possibly in a different order than the requests;
   * we re-order by `id` so the result indexes match the request indexes.
   *
   * Throws on the first failed response — callers that need per-item
   * outcomes should use `requestBatchSettled`.
   */
  async requestBatch<R = unknown>(
    items: ReadonlyArray<{ readonly method: string; readonly params?: unknown }>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const requests: JsonRpcRequest[] = items.map((item) => {
      const req: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: item.method,
      };
      if (item.params !== undefined) req.params = item.params;
      return req;
    });
    const responses = (await this.sendRaw(
      requests,
      opts?.timeoutMs,
    )) as JsonRpcResponse<R>[];

    // Re-order responses by id to match request order.
    const byId = new Map<number | string | null, JsonRpcResponse<R>>();
    for (const r of responses) byId.set(r.id, r);
    return requests.map((req) => {
      const r = byId.get(req.id);
      if (!r) {
        throw new SigningError({
          code: SigningErrorCode.INTERNAL_ERROR,
          message: `JSON-RPC batch missing response for id=${req.id}`,
          kind: this.kind,
        });
      }
      return this.unwrapResponse<R>(r);
    });
  }

  /**
   * Send a batch and return per-item settled outcomes (does not throw
   * on per-item JSON-RPC errors). HTTP failures still throw.
   */
  async requestBatchSettled<R = unknown>(
    items: ReadonlyArray<{ readonly method: string; readonly params?: unknown }>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<Array<{ ok: true; value: R } | { ok: false; error: SigningError }>> {
    if (items.length === 0) return [];
    const requests: JsonRpcRequest[] = items.map((item) => {
      const req: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: item.method,
      };
      if (item.params !== undefined) req.params = item.params;
      return req;
    });
    const responses = (await this.sendRaw(
      requests,
      opts?.timeoutMs,
    )) as JsonRpcResponse<R>[];

    const byId = new Map<number | string | null, JsonRpcResponse<R>>();
    for (const r of responses) byId.set(r.id, r);

    return requests.map((req) => {
      const r = byId.get(req.id);
      if (!r) {
        return {
          ok: false as const,
          error: new SigningError({
            code: SigningErrorCode.INTERNAL_ERROR,
            message: `JSON-RPC batch missing response for id=${req.id}`,
            kind: this.kind,
          }),
        };
      }
      if ('error' in r) {
        return {
          ok: false as const,
          error: new SigningError({
            code: r.error.code,
            message: r.error.message,
            data: r.error.data,
            kind: this.kind,
          }),
        };
      }
      return { ok: true as const, value: r.result };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async sendRaw(
    body: ReadonlyArray<JsonRpcRequest>,
    timeoutMs?: number,
  ): Promise<unknown[]> {
    const url = this.connection.gatewayUrl;
    const fetchImpl = this.connection.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${this.connection.accessToken}`,
    };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let httpResponse: Response;
    try {
      httpResponse = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body.length === 1 ? body[0] : body),
        // No-redirect + abort timeout: a 3xx must not replay the bearer token.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new SigningError({
          code: SigningErrorCode.DISCONNECTED,
          message: `Gateway request to ${url} timed out`,
          data: { cause: 'timeout' },
          kind: this.kind,
        });
      }
      throw new SigningError({
        code: SigningErrorCode.DISCONNECTED,
        message: `Gateway request to ${url} failed: ${(err as Error)?.message ?? err}`,
        data: { cause: 'network', original: String(err) },
        kind: this.kind,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!httpResponse.ok) {
      const text = await httpResponse.text().catch(() => '');
      const code = httpResponse.status === 401 || httpResponse.status === 403
        ? SigningErrorCode.UNAUTHORIZED
        : SigningErrorCode.INTERNAL_ERROR;
      throw new SigningError({
        code,
        message: `Gateway returned HTTP ${httpResponse.status}: ${text.slice(0, 500)}`,
        data: { status: httpResponse.status, body: text.slice(0, 2000) },
        kind: this.kind,
      });
    }

    let parsed: unknown;
    try {
      parsed = await httpResponse.json();
    } catch (err) {
      throw new SigningError({
        code: SigningErrorCode.PARSE_ERROR,
        message: `Gateway returned non-JSON: ${(err as Error)?.message ?? err}`,
        kind: this.kind,
      });
    }

    // JSON-RPC: a batch request returns an array; a single request
    // returns a single response object. Normalize to an array.
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  private unwrapResponse<R>(r: JsonRpcResponse<R>): R {
    if ('error' in r) {
      throw new SigningError({
        code: r.error.code,
        message: r.error.message,
        data: r.error.data,
        kind: this.kind,
      });
    }
    return r.result;
  }
}
