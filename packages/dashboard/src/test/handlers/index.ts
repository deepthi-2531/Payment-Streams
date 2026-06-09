/**
 * MSW request handlers for dashboard tests.
 *
 * Mirrors the proxy's REST surface as used by `src/api/client.ts`. Tests
 * import `server` from `setup.ts` and call `server.use(...)` to override
 * any of these per-test. Defaults match the empty-state shape the UI
 * components expect (zero streams, zero policies, healthy proxy).
 */

import { http, HttpResponse } from 'msw';
import { fixtures } from '../fixtures/index.js';

const proxyBase = 'http://localhost:4000';

export const handlers = [
  // GET /api/health
  http.get(`${proxyBase}/api/health`, () =>
    HttpResponse.json({
      status: 'ok',
      canton: { host: 'mock.canton.local', port: 5012 },
      readiness: {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        checks: {
          ledger: { status: 'ok', message: 'connected' },
        },
      },
    }),
  ),

  // GET /api/streams
  http.get(`${proxyBase}/api/streams`, () =>
    HttpResponse.json(fixtures.rawStreams),
  ),

  // GET /api/streams/:sender/:streamId
  http.get(`${proxyBase}/api/streams/:sender/:streamId`, ({ params }) => {
    const match = fixtures.rawStreams.find(
      (s) =>
        s.config.sender === params.sender &&
        s.config.streamId === params.streamId,
    );
    if (!match)
      return HttpResponse.json({ error: 'not found' }, { status: 404 });
    return HttpResponse.json(match);
  }),

  // GET /api/streams/:sender/:streamId/history
  http.get(
    `${proxyBase}/api/streams/:sender/:streamId/history`,
    () => HttpResponse.json([]),
  ),

  // POST /api/streams (create)
  http.post(`${proxyBase}/api/streams`, async ({ request }) => {
    const body = (await request.json()) as { streamId?: string };
    return HttpResponse.json({
      requestContractId: 'mock-request-cid',
      streamId: body?.streamId ?? 'mock-stream-id',
    });
  }),

  // POST /api/streams/:sender/:streamId/accept
  http.post(
    `${proxyBase}/api/streams/:sender/:streamId/accept`,
    ({ params }) =>
      HttpResponse.json({
        streamId: params.streamId,
      }),
  ),

  // POST /api/streams/:sender/:streamId/withdraw
  http.post(
    `${proxyBase}/api/streams/:sender/:streamId/withdraw`,
    () =>
      HttpResponse.json({
        amountWithdrawn: '100.00',
        newTotalWithdrawn: '100.00',
      }),
  ),

  // POST /api/streams/:sender/:streamId/cancel
  http.post(
    `${proxyBase}/api/streams/:sender/:streamId/cancel`,
    () => HttpResponse.json({ ok: true }),
  ),

  // GET /api/stream-requests
  http.get(`${proxyBase}/api/stream-requests`, () =>
    HttpResponse.json(fixtures.rawPendingRequests),
  ),

  // GET /api/policies
  http.get(`${proxyBase}/api/policies`, () =>
    HttpResponse.json(fixtures.rawPolicies),
  ),

  // POST /api/policies/:contractId/revoke
  http.post(`${proxyBase}/api/policies/:contractId/revoke`, () =>
    HttpResponse.json({ ok: true }),
  ),

  // GET /api/execution-logs
  http.get(`${proxyBase}/api/execution-logs`, () =>
    HttpResponse.json(fixtures.rawExecutionLogs),
  ),
];
