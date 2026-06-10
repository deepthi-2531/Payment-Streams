/**
 * @module transport/json-api
 *
 * Browser-safe HTTP transport for the Canton JSON API.
 *
 * Implements the Transport interface using fetch() against Canton's JSON API
 * (typically on port 7575). Unlike the gRPC transport, this works in any
 * JavaScript environment (browser, Deno, Bun, Node.js).
 *
 * Limitations vs gRPC transport:
 *   - No streaming (no getUpdates equivalent)
 *   - No offset tracking on query results
 *   - History falls back to state synthesis (no ledger events)
 *
 * @license Apache-2.0
 */

import type { Transport, CreateResult, TemplateId, CommandOptions, DisclosedContract } from './base.js';
import { parseTemplateId } from './base.js';

/**
 * Configuration for the JSON API transport.
 */
export interface JsonApiConfig {
  /** Base URL of the Canton JSON API (e.g. "http://localhost:7575"). */
  readonly baseUrl: string;

  /** JWT bearer token for authentication. */
  readonly token?: string;

  /** [M-9] Per-request timeout in ms (default 30000). Guards against a
   * hung upstream wedging the caller. */
  readonly requestTimeoutMs?: number;

  /** Parties to act as when submitting commands. */
  readonly actAs: string[];

  /** Additional parties whose contracts may be read. */
  readonly readAs?: string[];
}

/**
 * [L-9] Build a comma-joined party header value, rejecting any party id
 * that contains a comma, CR, or LF. Without this a crafted party string
 * like `Victim,Other` would widen the acting set, and a CR/LF would
 * inject additional HTTP headers. Party ids are
 * `<name>::<fingerprint>` and never legitimately contain these bytes.
 */
function assertSafePartyHeader(parties: readonly string[]): string {
  for (const p of parties) {
    if (/[,\r\n]/.test(p)) {
      throw new Error(
        `Refusing to build an act-as/read-as header: party id contains a ` +
          `comma or CR/LF and could widen the acting set or inject headers: ` +
          `${JSON.stringify(p)}`,
      );
    }
  }
  return parties.join(',');
}

/**
 * Format a TemplateId object as the Canton JSON API string format.
 * Canton JSON API expects "packageRef:ModuleName:EntityName"; packageRef
 * may be a package name or a concrete package ID hash depending on the
 * participant/runtime.
 */
function formatTemplateId(t: TemplateId): string {
  return `${t.packageId}:${t.moduleName}:${t.entityName}`;
}

/**
 * Encode disclosed contracts for the JSON API command `meta`. The
 * created-event blob stays base64 on this wire.
 */
function formatDisclosedContracts(
  disclosed: ReadonlyArray<DisclosedContract> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!disclosed || disclosed.length === 0) return undefined;
  return disclosed.map((dc) => {
    const entry: Record<string, unknown> = {
      templateId: formatTemplateId(parseTemplateId(dc.templateId)),
      contractId: dc.contractId,
      createdEventBlob: dc.createdEventBlob,
    };
    if (dc.synchronizerId !== undefined) {
      entry['synchronizerId'] = dc.synchronizerId;
    }
    return entry;
  });
}

/**
 * Browser-safe transport implementation using the Canton JSON API (HTTP).
 *
 * Usage:
 * ```typescript
 * import { JsonApiTransport } from '@canton-streams/sdk/browser';
 *
 * const transport = new JsonApiTransport({
 *   baseUrl: 'http://localhost:7575',
 *   token: 'my-jwt-token',
 *   actAs: ['Alice::1220...'],
 * });
 * ```
 */
export class JsonApiTransport implements Transport {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly defaultActAs: string[];
  private readonly defaultReadAs: string[];
  private readonly requestTimeoutMs: number;

  constructor(config: JsonApiConfig) {
    // Strip trailing slash from base URL
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.defaultActAs = config.actAs;
    this.defaultReadAs = config.readAs ?? [];
  }

  /**
   * Submit a create command for the given template.
   */
  async create<T>(
    templateId: TemplateId,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
    opts?: CommandOptions,
  ): Promise<CreateResult<T>> {
    const disclosed = formatDisclosedContracts(opts?.disclosedContracts);
    const body = {
      templateId: formatTemplateId(templateId),
      payload: argument,
      meta: {
        actAs: actAs.length > 0 ? actAs : this.defaultActAs,
        readAs: readAs ?? this.defaultReadAs,
        ...(disclosed ? { disclosedContracts: disclosed } : {}),
      },
    };

    const response = await this.post<{
      result: { contractId: string; payload: T };
      status: number;
    }>('/v1/create', body);

    return {
      contractId: response.result.contractId,
      result: response.result.payload,
    };
  }

  /**
   * Exercise a choice on a contract identified by its contract ID.
   */
  async exercise<T>(
    templateId: TemplateId,
    contractId: string,
    choiceName: string,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
    opts?: CommandOptions,
  ): Promise<T> {
    const disclosed = formatDisclosedContracts(opts?.disclosedContracts);
    const body = {
      templateId: formatTemplateId(templateId),
      contractId,
      choice: choiceName,
      argument,
      meta: {
        actAs: actAs.length > 0 ? actAs : this.defaultActAs,
        readAs: readAs ?? this.defaultReadAs,
        ...(disclosed ? { disclosedContracts: disclosed } : {}),
      },
    };

    const response = await this.post<{
      result: { exerciseResult: T };
      status: number;
    }>('/v1/exercise', body);

    return response.result.exerciseResult;
  }

  /**
   * Exercise a choice on a contract identified by its contract key.
   */
  async exerciseByKey<T>(
    templateId: TemplateId,
    key: unknown,
    choiceName: string,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
    opts?: CommandOptions,
  ): Promise<T> {
    const disclosed = formatDisclosedContracts(opts?.disclosedContracts);
    const body = {
      templateId: formatTemplateId(templateId),
      key,
      choice: choiceName,
      argument,
      meta: {
        actAs: actAs.length > 0 ? actAs : this.defaultActAs,
        readAs: readAs ?? this.defaultReadAs,
        ...(disclosed ? { disclosedContracts: disclosed } : {}),
      },
    };

    const response = await this.post<{
      result: { exerciseResult: T };
      status: number;
    }>('/v1/exercise', body);

    return response.result.exerciseResult;
  }

  /**
   * Query active contracts for a given template, optionally filtered.
   */
  async query<T>(
    templateId: TemplateId,
    filter: Record<string, unknown> | undefined,
    actAs: string[],
    readAs?: string[],
  ): Promise<T[]> {
    const body: Record<string, unknown> = {
      templateIds: [formatTemplateId(templateId)],
    };

    if (filter && Object.keys(filter).length > 0) {
      body['query'] = filter;
    }

    // The JSON API query endpoint uses readers from the token, but we
    // pass actAs/readAs via the request headers if the API version supports it.
    const headers: Record<string, string> = {};
    const parties = actAs.length > 0 ? actAs : this.defaultActAs;
    const readers = readAs ?? this.defaultReadAs;
    if (parties.length > 0) {
      headers['X-Da-Act-As'] = assertSafePartyHeader(parties);
    }
    if (readers.length > 0) {
      headers['X-Da-Read-As'] = assertSafePartyHeader(readers);
    }

    const response = await this.post<{
      result: Array<{ contractId: string; payload: T }>;
      status: number;
    }>('/v1/query', body, headers);

    return response.result.map((contract) => {
      // Attach contractId to the payload for SDK compatibility
      const payload = contract.payload as Record<string, unknown>;
      payload['_contractId'] = contract.contractId;
      return contract.payload;
    });
  }

  /**
   * Gracefully close the transport. No-op for HTTP (no persistent connection).
   */
  async close(): Promise<void> {
    // HTTP transport has no persistent connections to close
  }

  // -------------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------------

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    // [M-9] Two guards on the authenticated outbound call:
    //  - `redirect: 'error'`: never follow a 3xx. The default `follow`
    //    re-sends the Authorization header to the redirect target, so a
    //    malicious/compromised endpoint returning a 302 to an
    //    attacker host would exfiltrate the bearer token.
    //  - an AbortController timeout so a hung upstream can't wedge the
    //    caller indefinitely (DoS).
    const ac = new AbortController();
    const timeoutMs = this.requestTimeoutMs;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorDetail: string;
      try {
        const errorBody = await response.json();
        errorDetail = (errorBody as { errors?: string[] }).errors?.join('; ')
          ?? JSON.stringify(errorBody);
      } catch {
        errorDetail = await response.text();
      }

      throw new JsonApiError(
        response.status,
        `JSON API ${path} failed (${response.status}): ${errorDetail}`,
      );
    }

    return response.json() as Promise<T>;
  }
}

/**
 * Error from the Canton JSON API.
 */
export class JsonApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'JsonApiError';
    this.statusCode = statusCode;
  }
}
