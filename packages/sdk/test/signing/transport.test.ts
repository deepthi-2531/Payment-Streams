/**
 * Tests for the JSON-RPC 2.0 transport (STR-84.2).
 *
 * Covers:
 *   - Single request: id correlation, headers, body shape
 *   - Batch request: response re-ordering by id
 *   - JSON-RPC error envelope → SigningError mapping
 *   - HTTP errors mapped to SigningError with appropriate codes
 *   - Timeout handling
 *   - requestBatchSettled returns per-item outcomes
 */

import { describe, it, expect, vi } from 'vitest';
import { JsonRpcTransport } from '../../src/signing/transport.js';
import { SigningError, SigningErrorCode } from '../../src/signing/provider.js';

function mockFetch(handler: (body: unknown) => unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestBody = init?.body ? JSON.parse(String(init.body)) : null;
    const response = handler(requestBody);
    if (response instanceof Response) return response;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const baseConn = {
  gatewayUrl: 'https://gateway.test/api/v0/dapp',
  accessToken: 'test-jwt',
};

describe('JsonRpcTransport — single request', () => {
  it('sends valid JSON-RPC 2.0 envelope with method + params + id', async () => {
    let captured: unknown;
    const fetchImpl = mockFetch((body) => {
      captured = body;
      return { jsonrpc: '2.0', id: (body as { id: number }).id, result: { ok: true } };
    });
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    const r = await t.request('connect', { user: 'alice' });
    expect(r).toEqual({ ok: true });
    expect(captured).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'connect',
      params: { user: 'alice' },
    });
  });

  it('increments id across multiple requests', async () => {
    const ids: Array<number | string> = [];
    const fetchImpl = mockFetch((body) => {
      const b = body as { id: number };
      ids.push(b.id);
      return { jsonrpc: '2.0', id: b.id, result: null };
    });
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await t.request('a');
    await t.request('b');
    await t.request('c');
    expect(ids).toEqual([1, 2, 3]);
  });

  it('sends Bearer auth header', async () => {
    let capturedAuth: string | null = null;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const h = init?.headers as Record<string, string> | undefined;
      capturedAuth = h?.['authorization'] ?? null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await t.request('ping');
    expect(capturedAuth).toBe('Bearer test-jwt');
  });

  it('maps JSON-RPC error envelope to SigningError with code+message+data', async () => {
    const fetchImpl = mockFetch((body) => ({
      jsonrpc: '2.0',
      id: (body as { id: number }).id,
      error: {
        code: 4001,
        message: 'User rejected',
        data: { reason: 'cancel-clicked' },
      },
    }));
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await expect(t.request('connect')).rejects.toMatchObject({
      name: 'SigningError',
      code: 4001,
      message: 'User rejected',
      data: { reason: 'cancel-clicked' },
    });
  });

  it('propagates the kind tag into the error', async () => {
    const fetchImpl = mockFetch((body) => ({
      jsonrpc: '2.0',
      id: (body as { id: number }).id,
      error: { code: -32603, message: 'fail' },
    }));
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl }, 'fireblocks');
    await expect(t.request('x')).rejects.toMatchObject({ kind: 'fireblocks' });
  });
});

describe('JsonRpcTransport — HTTP failures', () => {
  it('maps HTTP 401 to UNAUTHORIZED', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 401 })) as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await expect(t.request('x')).rejects.toMatchObject({
      code: SigningErrorCode.UNAUTHORIZED,
    });
  });

  it('maps HTTP 500 to INTERNAL_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await expect(t.request('x')).rejects.toMatchObject({
      code: SigningErrorCode.INTERNAL_ERROR,
    });
  });

  it('maps network errors to DISCONNECTED', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await expect(t.request('x')).rejects.toMatchObject({
      code: SigningErrorCode.DISCONNECTED,
    });
  });

  it('maps non-JSON response to PARSE_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not json</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    await expect(t.request('x')).rejects.toMatchObject({
      code: SigningErrorCode.PARSE_ERROR,
    });
  });
});

describe('JsonRpcTransport — batch', () => {
  it('sends array body for batch + re-orders responses by id', async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      const reqs = capturedBody as Array<{ id: number; method: string }>;
      // Return out-of-order to verify ordering logic.
      const responses = reqs.map((r) => ({
        jsonrpc: '2.0', id: r.id, result: { method: r.method },
      })).reverse();
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    const results = await t.requestBatch([
      { method: 'one' },
      { method: 'two' },
      { method: 'three' },
    ]);
    expect(Array.isArray(capturedBody)).toBe(true);
    expect(results).toEqual([
      { method: 'one' },
      { method: 'two' },
      { method: 'three' },
    ]);
  });

  it('requestBatchSettled returns per-item outcomes without throwing', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const reqs = JSON.parse(String(init?.body ?? '[]')) as Array<{ id: number }>;
      const responses = reqs.map((r, i) =>
        i === 1
          ? { jsonrpc: '2.0', id: r.id, error: { code: 4001, message: 'rejected' } }
          : { jsonrpc: '2.0', id: r.id, result: i },
      );
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    const out = await t.requestBatchSettled([
      { method: 'a' },
      { method: 'b' },
      { method: 'c' },
    ]);
    expect(out[0]).toEqual({ ok: true, value: 0 });
    expect(out[1]?.ok).toBe(false);
    if (!out[1]?.ok) {
      expect((out[1] as { ok: false; error: SigningError }).error.code).toBe(4001);
    }
    expect(out[2]).toEqual({ ok: true, value: 2 });
  });

  it('empty batch returns empty array without sending a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl });
    const r = await t.requestBatch([]);
    expect(r).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('JsonRpcTransport — timeout', () => {
  it('aborts after timeoutMs', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      // Wait until aborted
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const t = new JsonRpcTransport({ ...baseConn, fetchImpl, timeoutMs: 30 });
    await expect(t.request('slow')).rejects.toMatchObject({
      code: SigningErrorCode.DISCONNECTED,
      message: expect.stringContaining('timed out'),
    });
  });
});
