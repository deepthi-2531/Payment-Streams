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

import type { Transport, CreateResult, TemplateId } from './base.js';

/**
 * Configuration for the JSON API transport.
 */
export interface JsonApiConfig {
  /** Base URL of the Canton JSON API (e.g. "http://localhost:7575"). */
  readonly baseUrl: string;

  /** JWT bearer token for authentication. */
  readonly token?: string;

  /** Parties to act as when submitting commands. */
  readonly actAs: string[];

  /** Additional parties whose contracts may be read. */
  readonly readAs?: string[];
}

/**
 * Format a TemplateId object as the Canton JSON API string format.
 * Canton JSON API expects "packageId:ModuleName:EntityName".
 */
function formatTemplateId(t: TemplateId): string {
  return `${t.packageId}:${t.moduleName}:${t.entityName}`;
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

  constructor(config: JsonApiConfig) {
    // Strip trailing slash from base URL
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
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
  ): Promise<CreateResult<T>> {
    const body = {
      templateId: formatTemplateId(templateId),
      payload: argument,
      meta: {
        actAs: actAs.length > 0 ? actAs : this.defaultActAs,
        readAs: readAs ?? this.defaultReadAs,
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
  ): Promise<T> {
    const body = {
      templateId: formatTemplateId(templateId),
      contractId,
      choice: choiceName,
      argument,
      meta: {
        actAs: actAs.length > 0 ? actAs : this.defaultActAs,
        readAs: readAs ?? this.defaultReadAs,
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
  ): Promise<T> {
    const body = {
      templateId: formatTemplateId(templateId),
      key,
      choice: choiceName,
      argument,
      meta: {
        actAs: actAs.length > 0 ? actAs : this.defaultActAs,
        readAs: readAs ?? this.defaultReadAs,
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
      headers['X-Da-Act-As'] = parties.join(',');
    }
    if (readers.length > 0) {
      headers['X-Da-Read-As'] = readers.join(',');
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

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
