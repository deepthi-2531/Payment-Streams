/**
 * @canton-streams/proxy
 *
 * Thin REST proxy that bridges the browser dashboard to the Canton ledger.
 *
 * The SDK's gRPC transport requires Node.js (@grpc/grpc-js, node:path,
 * node:url). This proxy runs as a Node process, wraps the SDK, and
 * exposes a simple REST API that the browser dashboard consumes via fetch.
 *
 * Architecture:
 *   Browser (Dashboard) ──fetch──▶ Proxy (Express) ──gRPC──▶ Canton Participant
 *
 * Routes:
 *   GET    /api/stream-requests                      → listPendingStreamRequests
 *   GET    /api/streams                              → listStreams
 *   GET    /api/streams/:sender/:streamId             → getStream
 *   GET    /api/streams/:sender/:streamId/history     → getStreamHistory
 *   POST   /api/streams                              → createStream
 *   POST   /api/streams/:sender/:streamId/accept      → acceptStream
 *   POST   /api/streams/:sender/:streamId/withdraw    → withdraw
 *   POST   /api/streams/:sender/:streamId/cancel      → cancel
 *   POST   /api/streams/:sender/:streamId/mutual-cancel → mutualCancel
 *   POST   /api/streams/:sender/:streamId/renew       → renew
 *   POST   /api/streams/:sender/:streamId/finalize    → finalize (service-only)
 *   GET    /api/flows                                 → listFlows
 *   POST   /api/flows                                 → createFlow
 *   POST   /api/flows/:sender/:flowId/top-up          → topUpFlow
 *   POST   /api/flows/:sender/:flowId/withdraw        → withdrawFlow
 *   POST   /api/flows/:sender/:flowId/stop            → stopFlow
 *   GET    /api/policies                              → listPolicies
 *   POST   /api/policies/:contractId/revoke           → revokePolicy
 *   GET    /api/execution-logs                        → listExecutionLogs
 *
 * Environment variables:
 *   PROXY_PORT            — Port to listen on (default: 4000)
 *   CANTON_HOST           — Canton participant host (default: localhost)
 *   CANTON_PORT           — Canton participant port (default: 6865)
 *   CANTON_USE_TLS        — Whether to use TLS (default: false)
 *   PROXY_USER_PARTIES    — Comma-separated user-party allowlist (unset = open access)
 *   PROXY_SERVICE_PARTIES — Comma-separated service-party allowlist
 *   PROXY_SERVICE_TOKEN   — JWT for the escrow operator service account
 *   PROXY_ESCROW_OPERATOR — Party ID for the escrow operator
 */

import express from 'express';
import cors from 'cors';
import Decimal from 'decimal.js';
import {
  CantonStreamsClient,
  validateTemplateRegistry,
  createDefaultOrchestrator,
  createLogger,
  TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
} from '@canton-streams/sdk';
import type {
  ClientConfig,
  StreamFilter,
  PendingStreamRequestFilter,
  CreateStreamParams,
  CreateFlowParams,
  FlowFilter,
  RenewParams,
} from '@canton-streams/sdk';
import { AssetType, VestingMode, SettlementMode } from '@canton-streams/sdk';

/** Module-level structured logger for proxy operations. */
const logger = createLogger('proxy', (process.env['LOG_LEVEL'] as any) ?? 'info');

/** Shared settlement orchestrator — stateless, safe to reuse across requests. */
const orchestrator = createDefaultOrchestrator();
import {
  type Action,
  type AuthConfig,
  type AuthResult,
  AuthError,
  parseAuthConfig,
  assertAuthConfigSafe,
  authorizeRequest,
  getRequiredRole,
  enforceRole,
  logAuthConfig,
} from './auth.js';
import {
  createReadinessConfig,
  runStartupReadinessChecks,
  type ReadinessReport,
} from './readiness.js';
import {
  parseAutoWithdrawConfig,
  runTokenStandardAutoWithdrawCycle,
  startTokenStandardAutoWithdrawWorker,
} from './auto-withdraw.js';
import {
  requireAmount,
  optionalAmount,
  requireNonNegativeAmount,
  requirePartyId,
  optionalPartyId,
  requireId,
  optionalId,
} from './validation.js';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env['PROXY_PORT'] ?? '4000', 10);
const CANTON_HOST = process.env['CANTON_HOST'] ?? 'localhost';
const CANTON_PORT = parseInt(process.env['CANTON_PORT'] ?? '6865', 10);
const CANTON_USE_TLS = process.env['CANTON_USE_TLS'] === 'true';
const CANTON_SYNCHRONIZER_ID = process.env['CANTON_SYNCHRONIZER_ID'];
const autoWithdrawConfig = parseAutoWithdrawConfig(process.env);

/** Auth configuration parsed from environment. */
const authConfig: AuthConfig = parseAuthConfig();
// Fail closed at boot: refuse to start with a spoofable dev-auth
// posture unless it is explicitly acknowledged AND loopback-bound.
assertAuthConfigSafe(authConfig);
let startupReadiness: ReadinessReport | null = null;
let stopAutoWithdrawWorker: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// CORS is allow-list only by default. Do not expose authenticated proxy
// routes to arbitrary browser origins.
const PROXY_ALLOWED_ORIGINS = (process.env['ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // No Origin header: server-to-server (curl, service-account) — allowed
      // because those flows authenticate via Tier-2 service token, not session.
      if (!origin) return cb(null, true);
      if (PROXY_ALLOWED_ORIGINS.length === 0) {
        // Dev safety: when no allow-list is configured AND we're in the
        // effective dev-auth posture, permit localhost only. Production
        // (jwt mode) must set ALLOWED_ORIGINS. Use the resolved
        // `authConfig.mode`, not the raw env, so a downgraded dev request
        // doesn't accidentally widen CORS.
        if (
          authConfig.mode === 'dev' &&
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ) {
          return cb(null, true);
        }
        return cb(new Error(`CORS: no ALLOWED_ORIGINS configured; origin ${origin} rejected`));
      }
      if (PROXY_ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not in ALLOWED_ORIGINS allow-list`));
    },
    credentials: false,
  }),
);

// Cap request bodies. Stream-create / batch payloads are small JSON;
// 64kb is generous and stops memory-exhaustion via oversized POSTs.
app.use(express.json({ limit: process.env['PROXY_BODY_LIMIT'] ?? '64kb' }));

// Lightweight in-process rate limiter (no external dependency). A
// fixed-window per-IP counter — enough to blunt brute-force / credential-
// exhaustion against this fund-moving surface. Operators fronting the proxy
// with a real gateway (nginx, API gateway) can disable it via
// PROXY_RATE_LIMIT_DISABLE=true. Tune with PROXY_RATE_LIMIT_MAX (requests)
// and PROXY_RATE_LIMIT_WINDOW_MS (window).
const RATE_LIMIT_DISABLED = process.env['PROXY_RATE_LIMIT_DISABLE'] === 'true';
const RATE_LIMIT_MAX = parseInt(process.env['PROXY_RATE_LIMIT_MAX'] ?? '120', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env['PROXY_RATE_LIMIT_WINDOW_MS'] ?? '60000',
  10,
);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
if (!RATE_LIMIT_DISABLED) {
  app.use((req, res, next) => {
    // Health/readiness probes are exempt so monitors don't get throttled.
    if (req.path === '/api/health' || req.path === '/api/readyz') return next();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }
    next();
  });
  // Evict stale buckets every window so the map can't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(k);
  }, RATE_LIMIT_WINDOW_MS);
  sweep.unref?.();
}

/**
 * Authorize the request for the given action and create a CantonStreamsClient.
 *
 * Uses the auth module to validate the caller's party/token against the
 * configured allowlists and per-action authorization rules.
 *
 * @throws AuthError if authorization fails
 */
async function createAuthorizedClient(
  req: express.Request,
  action: Action,
  additionalParties: string[] = [],
): Promise<CantonStreamsClient> {
  const auth: AuthResult = await authorizeRequest(req, action, authConfig);

  const config: ClientConfig = {
    host: CANTON_HOST,
    port: CANTON_PORT,
    useTls: CANTON_USE_TLS,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    token: auth.token,
    actAs: [...new Set([...auth.actAs, ...additionalParties.filter(Boolean)])],
  };

  return new CantonStreamsClient(config);
}

/**
 * Same as {@link createAuthorizedClient}, but also returns the resolved
 * caller party so routes that need to enforce party-scoped invariants
 * (e.g. "only the policy sender can revoke") do not have to re-read
 * the X-Canton-Party header.
 *
 * The caller party comes from the JWT `party`/`sub` claim (auth mode)
 * or from the dev-mode JWT extraction in `authorizeRequest`. This is
 * the same identity the client is then authorized to actAs.
 */
async function createAuthorizedClientWithParty(
  req: express.Request,
  action: Action,
  additionalParties: string[] = [],
): Promise<{ client: CantonStreamsClient; party: string }> {
  const auth: AuthResult = await authorizeRequest(req, action, authConfig);

  const config: ClientConfig = {
    host: CANTON_HOST,
    port: CANTON_PORT,
    useTls: CANTON_USE_TLS,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    token: auth.token,
    actAs: [...new Set([...auth.actAs, ...additionalParties.filter(Boolean)])],
  };

  return { client: new CantonStreamsClient(config), party: auth.actAs[0] ?? '' };
}

/**
 * Parties allowed to read across other parties' streams (operators,
 * dashboards run by the dApp). Defaults to the service-party allow-list,
 * extensible via PROXY_OPERATOR_READERS. When empty, NO party may read
 * streams it does not participate in.
 */
const OPERATOR_READERS: Set<string> = new Set(
  [
    ...(process.env['PROXY_SERVICE_PARTIES']?.split(',') ?? []),
    ...(process.env['PROXY_OPERATOR_READERS']?.split(',') ?? []),
    process.env['PROXY_ESCROW_OPERATOR'] ?? '',
  ]
    .map((p) => p.trim())
    .filter(Boolean),
);

/**
 * Enforce that a read request is scoped to the caller's own party.
 *
 * The ledger's own visibility is NOT a sufficient authorization boundary
 * for a multi-tenant proxy: if the proxy's actAs identity can see other
 * parties' contracts (operator/escrow readAs, sub-party grants), a caller
 * could pass `?sender=Victim` and read streams they don't participate in.
 *
 * Rule: any provided `sender`/`recipient` filter MUST equal the caller's
 * party, UNLESS the caller is a configured operator-reader. When no filter
 * is provided, we pin BOTH to the caller party so list results are scoped
 * to streams the caller participates in.
 *
 * Returns the (possibly defaulted) filter to use.
 */
function scopeReadFilter(
  caller: string,
  provided: { sender?: string; recipient?: string },
): { sender?: string; recipient?: string } {
  if (OPERATOR_READERS.has(caller)) return provided; // operator: unrestricted
  const offendsSender = provided.sender && provided.sender !== caller;
  const offendsRecipient = provided.recipient && provided.recipient !== caller;
  if (offendsSender || offendsRecipient) {
    throw new AuthError(
      403,
      'read_scope_violation',
      'You may only query streams where you are the sender or recipient.',
    );
  }
  // No explicit filter → scope to the caller. We can't express "sender OR
  // recipient = caller" in a single filter, so callers that want both
  // directions should issue two queries; default to recipient-scoped
  // (the inbox view) and let an explicit `?sender=<self>` cover outgoing.
  if (!provided.sender && !provided.recipient) {
    return { recipient: caller };
  }
  return provided;
}

/**
 * Create a service-authorized client for custody finalization.
 *
 * Builds actAs from the service identity plus any additional parties a route
 * genuinely needs. Token-standard finalize/withdraw now runs with the escrow
 * operator alone so the service can stay least-privilege.
 */
async function createServiceClient(
  req: express.Request,
  additionalParties: string[],
): Promise<CantonStreamsClient> {
  const auth: AuthResult = await authorizeRequest(req, 'finalize', authConfig);

  const config: ClientConfig = {
    host: CANTON_HOST,
    port: CANTON_PORT,
    useTls: CANTON_USE_TLS,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    token: auth.token,
    actAs: [...auth.actAs, ...additionalParties],
  };

  return new CantonStreamsClient(config);
}

function createInternalServiceClient(additionalParties: string[]): CantonStreamsClient {
  if (!authConfig.serviceToken) {
    throw new AuthError(
      503,
      'service_token_not_configured',
      'Custody finalization requires PROXY_SERVICE_TOKEN to be configured on the proxy',
    );
  }

  if (!authConfig.escrowOperator) {
    throw new AuthError(
      503,
      'escrow_operator_not_configured',
      'Custody finalization requires PROXY_ESCROW_OPERATOR to be configured on the proxy',
    );
  }

  const config: ClientConfig = {
    host: CANTON_HOST,
    port: CANTON_PORT,
    useTls: CANTON_USE_TLS,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    token: authConfig.serviceToken,
    actAs: [...new Set([authConfig.escrowOperator, ...additionalParties.filter(Boolean)])],
  };

  return new CantonStreamsClient(config);
}

function createTokenStandardExecutionClient(auth: AuthResult): CantonStreamsClient {
  if (!authConfig.escrowOperator) {
    throw new AuthError(
      503,
      'escrow_operator_not_configured',
      'Token-standard settlement requires PROXY_ESCROW_OPERATOR to be configured on the proxy',
    );
  }

  if (authConfig.serviceToken) {
    return createInternalServiceClient([]);
  }

  return createClientForAuthWithParties(auth, [authConfig.escrowOperator]);
}

function createClientForAuth(auth: AuthResult): CantonStreamsClient {
  const config: ClientConfig = {
    host: CANTON_HOST,
    port: CANTON_PORT,
    useTls: CANTON_USE_TLS,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    token: auth.token,
    actAs: auth.actAs,
  };

  return new CantonStreamsClient(config);
}

function createClientForAuthWithParties(
  auth: AuthResult,
  additionalParties: string[],
): CantonStreamsClient {
  const config: ClientConfig = {
    host: CANTON_HOST,
    port: CANTON_PORT,
    useTls: CANTON_USE_TLS,
    synchronizerId: CANTON_SYNCHRONIZER_ID,
    token: auth.token,
    actAs: [...new Set([...auth.actAs, ...additionalParties.filter(Boolean)])],
  };

  return new CantonStreamsClient(config);
}

function utilityExtraPartiesFromInstrument(
  instrumentRef: { issuer: string; depository?: string } | undefined,
): string[] {
  if (!instrumentRef) {
    return [];
  }

  return [...new Set([instrumentRef.issuer, instrumentRef.depository ?? ''].filter(Boolean))];
}

function utilityMutationParties(stream: Awaited<ReturnType<typeof getStreamOrThrow>>): string[] {
  if (stream.config.settlementMode === SettlementMode.TokenStandardCustody) {
    return [stream.config.recipient, stream.escrowRef?.escrowOperator ?? ''].filter(Boolean);
  }

  if (stream.config.settlementMode !== SettlementMode.UtilityHoldingCustody) {
    return [];
  }

  return [
    stream.config.recipient,
    stream.escrowRef?.escrowOperator ?? '',
    stream.escrowRef?.registrar ?? stream.config.instrumentRef?.issuer ?? '',
    stream.escrowRef?.provider ?? stream.config.instrumentRef?.depository ?? '',
  ].filter(Boolean);
}

async function getPendingRequestOrThrow(
  client: CantonStreamsClient,
  sender: string,
  streamId: string,
) {
  const requests = await client.listPendingStreamRequests({ sender });
  const request = requests.find(
    (candidate) => candidate.config.sender === sender && candidate.config.streamId === streamId,
  );

  if (!request) {
    // The SDK currently builds a StreamAdmin directly (V2 metadata +
    // wallet-driven AllocationFactory_Allocate), so there is no
    // intermediate CreateStreamRequest contract for the recipient to
    // accept. /accept and /reject therefore return 404 by design until
    // the future V2 StreamAdminRequest template lands. Surface that
    // architectural context so API users do not have to chase it down
    // from the route name alone.
    throw new AuthError(
      404,
      'request_not_found',
      `No pending stream-request contract for sender=${sender}, streamId=${streamId}. ` +
        'The dashboard creates V2 StreamAdmin directly (no propose/accept ceremony at this layer); ' +
        'the /accept and /reject routes are reserved for the future V2 StreamAdminRequest template. ' +
        'Recipient preapproval today happens in the Amulet wallet.',
    );
  }

  return request;
}

async function getAcceptedTokenStandardRequestOrThrow(
  client: CantonStreamsClient,
  actAs: string[],
  sender: string,
  streamId: string,
  acceptedRequestContractId?: string,
) {
  const results = await client._transport.query<any>(
    TEMPLATE_TOKEN_STANDARD_ACCEPTED_REQUEST,
    undefined,
    actAs,
    undefined,
  );

  const match = results.find((candidate) => {
    const contractId = candidate.contractId ?? candidate.contract_id ?? '';
    const config = candidate.config ?? candidate;
    if (acceptedRequestContractId) {
      return contractId === acceptedRequestContractId;
    }
    return config.sender === sender && config.streamId === streamId;
  });

  if (!match) {
    throw new AuthError(
      404,
      'accepted_request_not_found',
      `Accepted token-standard request not found: sender=${sender}, streamId=${streamId}`,
    );
  }

  const config = match.config ?? match;
  return {
    contractId: match.contractId ?? match.contract_id ?? '',
    config: {
      recipient: config.recipient ?? '',
      instrumentRef: config.instrumentRef
        ? {
            issuer: config.instrumentRef.issuer ?? '',
            depository: config.instrumentRef.depository ?? '',
          }
        : undefined,
    },
  };
}

async function getStreamOrThrow(client: CantonStreamsClient, sender: string, streamId: string) {
  try {
    return await client.getStream(sender, streamId);
  } catch {
    throw new AuthError(
      404,
      'stream_not_found',
      `Stream not found: sender=${sender}, streamId=${streamId}`,
    );
  }
}

async function getFlowOrThrow(client: CantonStreamsClient, sender: string, flowId: string) {
  const flows = await client.listFlows({ sender });
  const flow = flows.find((f) => f.sender === sender && f.streamId === flowId);
  if (!flow) {
    throw new AuthError(
      404,
      'flow_not_found',
      `Flow not found: sender=${sender}, flowId=${flowId}`,
    );
  }
  return flow;
}

// ---------------------------------------------------------------------------
// JSON serialization helpers for Decimal
// ---------------------------------------------------------------------------

/**
 * Recursively convert Decimal instances to strings for JSON serialization.
 */
function serializeForJson(obj: unknown): unknown {
  if (obj instanceof Decimal) return obj.toString();
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(serializeForJson);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeForJson(value);
    }
    return result;
  }
  return obj;
}

/**
 * Parse CreateStreamParams from a JSON request body.
 * Converts string amounts back to Decimal instances.
 */
function parseCreateParams(
  body: Record<string, unknown>,
  callerParty?: string,
): CreateStreamParams {
  const rawRef = body['instrumentRef'] as
    | { depository: string; issuer: string; instrumentId: string; instrumentVersion: string }
    | undefined;
  // Validate before any Decimal/Date construction.
  const sender = requirePartyId(body['sender'] ?? callerParty, 'sender');
  const recipient = requirePartyId(body['recipient'], 'recipient');
  const totalDeposited = requireAmount(body['totalDeposited'], 'totalDeposited');
  return {
    streamId: (body['streamId'] as string | undefined) ?? crypto.randomUUID(),
    sender,
    recipient,
    totalDeposited,
    startTime: new Date(body['startTime'] as string),
    endTime: new Date(body['endTime'] as string),
    vestingMode: parseVestingMode(body['vestingMode'] as Record<string, unknown>),
    assetType: (body['assetType'] as AssetType) ?? AssetType.GlobalCip56,
    instrumentRef: rawRef
      ? {
          depository: rawRef.depository,
          issuer: rawRef.issuer,
          instrumentId: rawRef.instrumentId,
          instrumentVersion: rawRef.instrumentVersion,
        }
      : undefined,
    holdingCid: body['holdingCid'] as string,
    fundingReference: body['fundingReference'] as string,
    senderAccount: body['senderAccount'] as CreateStreamParams['senderAccount'],
    recipientAccount: body['recipientAccount'] as CreateStreamParams['recipientAccount'],
    cancellable: body['cancellable'] as boolean,
    settlementMode:
      (body['settlementMode'] as SettlementMode) ?? SettlementMode.TokenStandardCustody,
    escrowOperator: body['escrowOperator'] as string | undefined,
    escrowAccount: body['escrowAccount'] as CreateStreamParams['escrowAccount'],
  };
}

function parseVestingMode(raw: Record<string, unknown>): CreateStreamParams['vestingMode'] {
  const mode = raw['mode'] as string;
  switch (mode) {
    case VestingMode.CliffLinear:
      return { mode: VestingMode.CliffLinear, cliffTime: new Date(raw['cliffTime'] as string) };
    case VestingMode.Stepped:
      return {
        mode: VestingMode.Stepped,
        stepInterval: raw['stepInterval'] as number,
        amountPerStep: requireAmount(raw['amountPerStep'], 'amountPerStep'),
      };
    case VestingMode.RenewableTerm:
      return { mode: VestingMode.RenewableTerm, termDuration: raw['termDuration'] as number };
    case VestingMode.Linear:
    default:
      return { mode: VestingMode.Linear };
  }
}

function parseRenewParams(body: Record<string, unknown>): RenewParams {
  return {
    additionalAmount: requireAmount(body['additionalAmount'], 'additionalAmount'),
    newEndTime: new Date(body['newEndTime'] as string),
    holdingCid: body['holdingCid'] as string,
    senderAccount: body['senderAccount'] as RenewParams['senderAccount'],
    fundingReference: body['fundingReference'] as string | undefined,
    settlementReference: body['settlementReference'] as string | undefined,
    confirmedAdditionalAmount: optionalAmount(
      body['confirmedAdditionalAmount'],
      'confirmedAdditionalAmount',
    ),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/stream-requests — list pending stream requests visible to the caller */
app.get('/api/stream-requests', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    // Scope the sender/recipient filter to the caller's own party.
    const scoped = scopeReadFilter(authed.party, {
      sender: req.query['sender'] as string | undefined,
      recipient: req.query['recipient'] as string | undefined,
    });
    const filter: {
      sender?: string;
      recipient?: string;
      assetType?: PendingStreamRequestFilter['assetType'];
    } = {};
    if (scoped.sender) filter.sender = scoped.sender;
    if (scoped.recipient) filter.recipient = scoped.recipient;
    if (req.query['assetType'])
      filter.assetType = req.query['assetType'] as PendingStreamRequestFilter['assetType'];

    const requests = await client.listPendingStreamRequests(
      Object.keys(filter).length > 0 ? filter : undefined,
    );
    res.json(serializeForJson(requests));
  } catch (err) {
    handleError(res, err, 'listPendingStreamRequests');
  } finally {
    await client?.close();
  }
});

/** GET /api/streams — list all visible streams, optionally filtered */
app.get('/api/streams', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    // Scope the sender/recipient filter to the caller's own party.
    const scoped = scopeReadFilter(authed.party, {
      sender: req.query['sender'] as string | undefined,
      recipient: req.query['recipient'] as string | undefined,
    });
    const filter: {
      sender?: string;
      recipient?: string;
      status?: StreamFilter['status'];
      vestingMode?: StreamFilter['vestingMode'];
      settlementMode?: StreamFilter['settlementMode'];
    } = {};
    if (scoped.sender) filter.sender = scoped.sender;
    if (scoped.recipient) filter.recipient = scoped.recipient;
    if (req.query['status']) filter.status = req.query['status'] as StreamFilter['status'];
    if (req.query['vestingMode'])
      filter.vestingMode = req.query['vestingMode'] as StreamFilter['vestingMode'];
    if (req.query['settlementMode'])
      filter.settlementMode = req.query['settlementMode'] as StreamFilter['settlementMode'];

    const streams = await client.listStreams(
      Object.keys(filter).length > 0 ? (filter as StreamFilter) : undefined,
    );
    res.json(serializeForJson(streams));
  } catch (err) {
    handleError(res, err, 'listStreams');
  } finally {
    await client?.close();
  }
});

/** GET /api/streams/:sender/:streamId — get a specific stream by key */
app.get('/api/streams/:sender/:streamId', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    const stream = await client.getStream(req.params['sender']!, req.params['streamId']!);
    // A specific stream is only readable by its participants (or a
    // configured operator-reader). The ledger may surface it more broadly
    // through the proxy's actAs identity, so enforce participation here.
    const isParticipant =
      stream.config.sender === authed.party ||
      stream.config.recipient === authed.party;
    if (!isParticipant && !OPERATOR_READERS.has(authed.party)) {
      throw new AuthError(
        403,
        'read_scope_violation',
        'You may only read a stream where you are the sender or recipient.',
      );
    }
    res.json(serializeForJson(stream));
  } catch (err) {
    handleError(res, err, 'getStream');
  } finally {
    await client?.close();
  }
});

/** GET /api/streams/:sender/:streamId/history — stream event history */
app.get('/api/streams/:sender/:streamId/history', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    // History exposes the same stream data as the getter, so apply the
    // same participation check: only the sender, recipient, or a
    // configured operator-reader may read it.
    const stream = await client.getStream(req.params['sender']!, req.params['streamId']!);
    const isParticipant =
      stream.config.sender === authed.party ||
      stream.config.recipient === authed.party;
    if (!isParticipant && !OPERATOR_READERS.has(authed.party)) {
      throw new AuthError(
        403,
        'read_scope_violation',
        'You may only read a stream where you are the sender or recipient.',
      );
    }
    const events = await client.getStreamHistory(req.params['sender']!, req.params['streamId']!);
    res.json(serializeForJson(events));
  } catch (err) {
    handleError(res, err, 'getStreamHistory');
  } finally {
    await client?.close();
  }
});

/** POST /api/streams — create a new stream */
app.post('/api/streams', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    // Enforce: caller must be the sender. If the body specifies a sender,
    // verify it matches the caller. Otherwise the caller IS the sender.
    const bodySender = requirePartyId(req.body?.['sender'] ?? auth.party, 'sender');
    enforceRole(auth.party, getRequiredRole('create'), bodySender);

    const params = parseCreateParams(req.body, auth.party);
    client = createClientForAuth(auth);
    const result = await client.createStream(params);
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err, 'createStream');
  } finally {
    await client?.close();
  }
});

/** POST /api/streams/:sender/:streamId/accept — recipient accepts a CreateStreamRequest */
app.post('/api/streams/:sender/:streamId/accept', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  let serviceClient: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'accept', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const streamId = requireId(req.params['streamId'], 'streamId');
    client = createClientForAuth(auth);
    const request = await getPendingRequestOrThrow(client, sender, streamId);
    enforceRole(
      auth.party,
      getRequiredRole('accept'),
      request.config.sender,
      request.config.recipient,
    );
    const accepted = await client.acceptStream(sender, streamId);

    if (
      request.config.settlementMode === SettlementMode.UtilityHoldingCustody ||
      request.config.settlementMode === SettlementMode.LocalAssetCustody
    ) {
      const additionalParties = [
        sender,
        request.config.recipient,
        request.escrowOperator ?? authConfig.escrowOperator ?? '',
        ...utilityExtraPartiesFromInstrument(request.config.instrumentRef),
      ];

      serviceClient =
        authConfig.mode === 'dev'
          ? createClientForAuthWithParties(auth, additionalParties)
          : createInternalServiceClient(additionalParties);
      const finalized = await serviceClient.finalizeEscrow(
        sender,
        streamId,
        accepted.escrowContractId,
        request.config.settlementMode,
      );
      res.json(finalized);
      return;
    }

    res.json(accepted);
  } catch (err) {
    handleError(res, err, 'acceptStream');
  } finally {
    await client?.close();
    await serviceClient?.close();
  }
});

/** POST /api/streams/:sender/:streamId/withdraw */
app.post('/api/streams/:sender/:streamId/withdraw', async (req, res) => {
  let lookupClient: CantonStreamsClient | undefined;
  let client: CantonStreamsClient | undefined;
  let serviceClient: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const streamId = requireId(req.params['streamId'], 'streamId');
    lookupClient = createClientForAuth(auth);
    const stream = await getStreamOrThrow(lookupClient, sender, streamId);
    enforceRole(
      auth.party,
      getRequiredRole('withdraw'),
      stream.config.sender,
      stream.config.recipient,
    );
    client = createClientForAuthWithParties(auth, utilityMutationParties(stream));

    // TokenStandardCustody: auto-orchestrate if no settlement reference supplied
    if (stream.config.settlementMode === SettlementMode.TokenStandardCustody) {
      const manualRef = optionalId(req.body?.['settlementReference'], 'settlementReference');
      serviceClient = createTokenStandardExecutionClient(auth);

      if (manualRef) {
        // Manual mode: caller already executed the external transfer and supplies the ref.
        // We must pass the SAME withdrawTime used to compute settledAmount, so that the
        // Daml contract's accrual check (settledAmount == withdrawable(withdrawTime)) passes.
        //
        // If the caller explicitly supplies settledAmount, honour it (they know what they
        // transferred).  If not, auto-compute the currently-withdrawable amount using the
        // stream config — both the amount and the timestamp are fixed at this instant and
        // threaded through to the SDK so Daml sees consistent values.
        const withdrawTime = new Date();
        let settledAmount: Decimal;
        const suppliedSettledAmount = optionalAmount(req.body?.['settledAmount'], 'settledAmount');
        if (suppliedSettledAmount) {
          settledAmount = suppliedSettledAmount;
        } else {
          // Auto-compute: linearAccrual(totalDeposited, start, end, withdrawTime) − totalWithdrawn
          const nowMicros = BigInt(withdrawTime.getTime()) * 1000n;
          const startMicros = BigInt(stream.config.startTime.getTime()) * 1000n;
          const endMicros = BigInt(stream.config.endTime.getTime()) * 1000n;
          const elapsed =
            nowMicros <= startMicros
              ? 0n
              : nowMicros >= endMicros
                ? endMicros - startMicros
                : nowMicros - startMicros;
          const duration = endMicros - startMicros;
          // Replicate Daml's Numeric 10 arithmetic (mul FIRST, then div — matches
          // Daml left-to-right evaluation of `totalDeposited * elapsed / duration`).
          // Daml LF uses Java BigDecimal with HALF_EVEN rounding for division,
          // NOT truncation toward zero despite the Accrual.daml comment.
          const accrued = stream.config.totalDeposited
            .times(new Decimal(elapsed.toString()))
            .dividedBy(new Decimal(duration.toString()))
            .toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
          settledAmount = Decimal.max(0, accrued.sub(stream.state.totalWithdrawn)).toDecimalPlaces(
            10,
            Decimal.ROUND_DOWN,
          );
          logger.info(
            {
              withdrawTimeMs: withdrawTime.getTime(),
              nowMicros: nowMicros.toString(),
              startMicros: startMicros.toString(),
              elapsed: elapsed.toString(),
              duration: duration.toString(),
              accrued: accrued.toString(),
              totalWithdrawn: stream.state.totalWithdrawn.toString(),
              settledAmount: settledAmount.toString(),
            },
            '[TokenStandard withdraw] auto-computed settledAmount',
          );
        }
        const result = await serviceClient.withdraw(sender, streamId, {
          settlementReference: manualRef,
          settledAmount,
          withdrawTime,
        });
        res.json(serializeForJson(result));
      } else {
        // Orchestrated mode: the proxy service executes the payout and updates the stream.
        const result = await orchestrator.withdraw(
          serviceClient._transport,
          sender,
          streamId,
          [authConfig.escrowOperator!],
          logger,
        );
        res.json(serializeForJson(result));
      }
      return;
    }

    const result = await client.withdraw(sender, streamId, undefined);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'withdraw');
  } finally {
    await lookupClient?.close();
    await client?.close();
    await serviceClient?.close();
  }
});

/** POST /api/streams/:sender/:streamId/cancel */
app.post('/api/streams/:sender/:streamId/cancel', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  let lookupClient: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'cancel', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const streamId = requireId(req.params['streamId'], 'streamId');
    // Enforce: caller must be the sender (cancel is sender-only)
    enforceRole(auth.party, getRequiredRole('cancel'), sender);
    lookupClient = createClientForAuth(auth);
    const stream = await getStreamOrThrow(lookupClient, sender, streamId);
    client = createClientForAuthWithParties(auth, utilityMutationParties(stream));

    if (stream.config.settlementMode === SettlementMode.TokenStandardCustody) {
      const recipientSettlementReference = optionalId(
        req.body?.['recipientSettlementReference'],
        'recipientSettlementReference',
      );
      const senderRefundReference = optionalId(
        req.body?.['senderRefundReference'],
        'senderRefundReference',
      );
      const hasManualRefs =
        recipientSettlementReference !== undefined || senderRefundReference !== undefined;

      if (hasManualRefs) {
        // Manual mode: caller supplies settlement refs for both legs
        const tokenStandardParams = {
          recipientSettlementReference,
          senderRefundReference,
          recipientAmountSettled: requireAmount(
            req.body?.['recipientAmountSettled'],
            'recipientAmountSettled',
          ),
          senderRefundSettled: requireAmount(
            req.body?.['senderRefundSettled'],
            'senderRefundSettled',
          ),
        };
        const result = await client.cancel(sender, streamId, tokenStandardParams);
        res.json(serializeForJson(result));
      } else {
        // Orchestrated mode: compute amounts and execute transfers automatically
        const actAs = utilityMutationParties(stream).concat([auth.party]);
        const result = await orchestrator.cancel(
          client._transport,
          sender,
          streamId,
          actAs,
          logger,
          false,
        );
        res.json(serializeForJson(result));
      }
      return;
    }

    const result = await client.cancel(sender, streamId, undefined);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'cancel');
  } finally {
    await lookupClient?.close();
    await client?.close();
  }
});

/** POST /api/streams/:sender/:streamId/mutual-cancel */
app.post('/api/streams/:sender/:streamId/mutual-cancel', async (req, res) => {
  let lookupClient: CantonStreamsClient | undefined;
  let client: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'mutual-cancel', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const streamId = requireId(req.params['streamId'], 'streamId');
    lookupClient = createClientForAuth(auth);
    const stream = await getStreamOrThrow(lookupClient, sender, streamId);
    enforceRole(
      auth.party,
      getRequiredRole('mutual-cancel'),
      stream.config.sender,
      stream.config.recipient,
    );
    // Mutual cancel requires both sender + recipient as authorizers.
    // For UtilityHoldingCustody, utilityMutationParties already includes recipient;
    // for NumericLegacy we must add both parties explicitly.
    const mutualParties = [
      stream.config.sender,
      stream.config.recipient,
      ...utilityMutationParties(stream),
    ];
    client = createClientForAuthWithParties(auth, mutualParties);

    if (stream.config.settlementMode === SettlementMode.TokenStandardCustody) {
      const recipientSettlementReference = optionalId(
        req.body?.['recipientSettlementReference'],
        'recipientSettlementReference',
      );
      const senderRefundReference = optionalId(
        req.body?.['senderRefundReference'],
        'senderRefundReference',
      );
      const hasManualRefs =
        recipientSettlementReference !== undefined || senderRefundReference !== undefined;

      if (hasManualRefs) {
        // Manual mode: caller supplies settlement refs for both legs
        const tokenStandardParams = {
          recipientSettlementReference,
          senderRefundReference,
          recipientAmountSettled: requireAmount(
            req.body?.['recipientAmountSettled'],
            'recipientAmountSettled',
          ),
          senderRefundSettled: requireAmount(
            req.body?.['senderRefundSettled'],
            'senderRefundSettled',
          ),
        };
        const result = await client.mutualCancel(sender, streamId, tokenStandardParams);
        res.json(serializeForJson(result));
      } else {
        // Orchestrated mode: compute amounts and execute both transfer legs automatically
        const actAs = [...mutualParties, auth.party].filter(Boolean);
        const result = await orchestrator.cancel(
          client._transport,
          sender,
          streamId,
          actAs,
          logger,
          true,
        );
        res.json(serializeForJson(result));
      }
      return;
    }

    const result = await client.mutualCancel(sender, streamId, undefined);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'mutualCancel');
  } finally {
    await lookupClient?.close();
    await client?.close();
  }
});

/** POST /api/streams/:sender/:streamId/renew */
app.post('/api/streams/:sender/:streamId/renew', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  let lookupClient: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'renew', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const streamId = requireId(req.params['streamId'], 'streamId');
    // Enforce: caller must be the sender (renew is sender-only)
    enforceRole(auth.party, getRequiredRole('renew'), sender);
    lookupClient = createClientForAuth(auth);
    const stream = await getStreamOrThrow(lookupClient, sender, streamId);
    client = createClientForAuthWithParties(auth, utilityMutationParties(stream));

    if (stream.config.settlementMode === SettlementMode.TokenStandardCustody) {
      const manualRef = optionalId(req.body?.['settlementReference'], 'settlementReference');

      const params = parseRenewParams(req.body);

      if (manualRef) {
        // Manual mode: caller already executed the top-up transfer and supplies the ref
        const result = await client.renew(sender, streamId, params);
        res.json(serializeForJson(result));
      } else {
        // Orchestrated mode: execute sender → escrow transfer, then renew on-ledger
        const actAs = utilityMutationParties(stream).concat([auth.party]);
        const result = await orchestrator.renew(
          client._transport,
          sender,
          streamId,
          params,
          actAs,
          logger,
        );
        res.json(serializeForJson(result));
      }
      return;
    }

    const params = parseRenewParams(req.body);
    const result = await client.renew(sender, streamId, params);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'renew');
  } finally {
    await lookupClient?.close();
    await client?.close();
  }
});

/**
 * POST /api/streams/:sender/:streamId/finalize — service-only custody finalization.
 *
 * This route is reserved for custody workflows. The escrow operator
 * service uses this to finalize accepted stream requests by locking, splitting,
 * and transferring real holdings into escrow custody.
 *
 * Requires PROXY_SERVICE_TOKEN authentication.
 */
app.post('/api/streams/:sender/:streamId/finalize', async (req, res) => {
  let requestClient: CantonStreamsClient | undefined;
  let client: CantonStreamsClient | undefined;
  try {
    const sender = requirePartyId(req.params['sender'], 'sender');
    const streamId = requireId(req.params['streamId'], 'streamId');
    const acceptedRequestContractId = optionalId(
      req.body?.['acceptedRequestContractId'],
      'acceptedRequestContractId',
    );
    const settlementMode =
      typeof req.body?.['settlementMode'] === 'string'
        ? (req.body['settlementMode'] as SettlementMode)
        : undefined;

    if (settlementMode === SettlementMode.TokenStandardCustody) {
      const escrowOperator = authConfig.escrowOperator;
      if (!escrowOperator) {
        throw new AuthError(
          503,
          'service_not_configured',
          'TokenStandardCustody finalization requires PROXY_ESCROW_OPERATOR to be configured',
        );
      }

      const serviceActAs = [escrowOperator];
      requestClient = await createServiceClient(req, []);
      const acceptedRequest = await getAcceptedTokenStandardRequestOrThrow(
        requestClient,
        serviceActAs,
        sender,
        streamId,
        acceptedRequestContractId,
      );

      if (!acceptedRequest.config.recipient) {
        throw new AuthError(
          500,
          'accepted_request_invalid',
          'Accepted token-standard request is missing recipient',
        );
      }

      const actAs = [escrowOperator];
      client = await createServiceClient(req, []);

      const manualRef = optionalId(req.body?.['settlementReference'], 'settlementReference');

      if (!manualRef) {
        const result = await orchestrator.finalize(
          client._transport,
          sender,
          streamId,
          escrowOperator,
          actAs,
          logger,
          acceptedRequest.contractId || acceptedRequestContractId,
        );
        res.json(serializeForJson(result));
        return;
      }
    } else {
      requestClient = await createServiceClient(req, []);
      const request = await getPendingRequestOrThrow(requestClient, sender, streamId);
      const recipient = request.config.recipient;
      const registrar = request.config.instrumentRef?.issuer ?? '';
      client = await createServiceClient(req, [sender, recipient, registrar]);
    }

    const finalizeParams =
      settlementMode === SettlementMode.TokenStandardCustody
        ? {
            escrowReference: optionalId(req.body?.['escrowReference'], 'escrowReference'),
            settlementReference: optionalId(
              req.body?.['settlementReference'],
              'settlementReference',
            ),
            confirmedEscrowAmount: optionalAmount(
              req.body?.['confirmedEscrowAmount'],
              'confirmedEscrowAmount',
            ),
          }
        : undefined;
    const result = await client.finalizeEscrow(
      sender,
      streamId,
      acceptedRequestContractId,
      settlementMode,
      finalizeParams,
    );
    res.json(result);
  } catch (err) {
    handleError(res, err, 'finalize');
  } finally {
    await requestClient?.close();
    await client?.close();
  }
});

// ---------------------------------------------------------------------------
// Open-ended flow routes (StreamFlow — non-prefunded / rolling top-up)
// ---------------------------------------------------------------------------

/** GET /api/flows — list open-ended flows visible to the caller */
app.get('/api/flows', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    // Scope the sender/recipient filter to the caller's own party.
    const scoped = scopeReadFilter(authed.party, {
      sender: req.query['sender'] as string | undefined,
      recipient: req.query['recipient'] as string | undefined,
    });
    const filter: { sender?: string; recipient?: string; status?: FlowFilter['status'] } = {};
    if (scoped.sender) filter.sender = scoped.sender;
    if (scoped.recipient) filter.recipient = scoped.recipient;
    if (req.query['status']) filter.status = req.query['status'] as FlowFilter['status'];

    const flows = await client.listFlows(
      Object.keys(filter).length > 0 ? (filter as FlowFilter) : undefined,
    );
    res.json(serializeForJson(flows));
  } catch (err) {
    handleError(res, err, 'listFlows');
  } finally {
    await client?.close();
  }
});

/** POST /api/flows — create an open-ended StreamFlow */
app.post('/api/flows', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    // Enforce: caller must be the sender.
    const sender = requirePartyId(req.body?.['sender'] ?? auth.party, 'sender');
    enforceRole(auth.party, getRequiredRole('create'), sender);

    const recipient = requirePartyId(req.body?.['recipient'], 'recipient');
    const escrowOperator = requirePartyId(
      req.body?.['escrowOperator'] ?? authConfig.escrowOperator,
      'escrowOperator',
    );
    const rawRef = req.body?.['instrumentRef'] as
      | { depository?: unknown; issuer?: unknown; instrumentId?: unknown; instrumentVersion?: unknown }
      | undefined;
    if (!rawRef) {
      throw new AuthError(400, 'invalid_input', 'Invalid instrumentRef: required');
    }

    const params: CreateFlowParams = {
      streamId: optionalId(req.body?.['streamId'], 'streamId'),
      sender,
      recipient,
      escrowOperator,
      instrumentRef: {
        depository: requirePartyId(rawRef.depository, 'instrumentRef.depository'),
        issuer: requirePartyId(rawRef.issuer, 'instrumentRef.issuer'),
        instrumentId: requireId(rawRef.instrumentId, 'instrumentRef.instrumentId'),
        instrumentVersion: requireId(rawRef.instrumentVersion, 'instrumentRef.instrumentVersion'),
      },
      flowRate: requireAmount(req.body?.['flowRate'], 'flowRate'),
      fundedAmount: requireNonNegativeAmount(req.body?.['fundedAmount'], 'fundedAmount'),
      startTime: req.body?.['startTime'] ? new Date(req.body['startTime'] as string) : new Date(),
    };

    // StreamFlow is signed by sender + recipient + escrowOperator.
    client = createClientForAuthWithParties(auth, [recipient, escrowOperator]);
    const result = await client.createFlow(params);
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err, 'createFlow');
  } finally {
    await client?.close();
  }
});

/** POST /api/flows/:sender/:flowId/top-up — sender adds to the funded balance */
app.post('/api/flows/:sender/:flowId/top-up', async (req, res) => {
  let lookupClient: CantonStreamsClient | undefined;
  let client: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'top-up', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const flowId = requireId(req.params['flowId'], 'flowId');
    // Enforce: caller must be the sender (top-up is sender-only)
    enforceRole(auth.party, getRequiredRole('top-up'), sender);
    const topUpAmount = requireAmount(req.body?.['topUpAmount'], 'topUpAmount');
    const settlementReference = requireId(
      req.body?.['settlementReference'],
      'settlementReference',
    );

    lookupClient = createClientForAuth(auth);
    const flow = await getFlowOrThrow(lookupClient, sender, flowId);
    // TopUp_Flow is controlled by sender + escrowOperator.
    client = createClientForAuthWithParties(auth, [flow.escrowOperator]);
    const result = await client.topUpFlow(sender, flowId, { topUpAmount, settlementReference });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'topUpFlow');
  } finally {
    await lookupClient?.close();
    await client?.close();
  }
});

/** POST /api/flows/:sender/:flowId/withdraw — recipient claims accrued + funded */
app.post('/api/flows/:sender/:flowId/withdraw', async (req, res) => {
  let lookupClient: CantonStreamsClient | undefined;
  let client: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const flowId = requireId(req.params['flowId'], 'flowId');
    const settlementReference = requireId(
      req.body?.['settlementReference'],
      'settlementReference',
    );

    lookupClient = createClientForAuth(auth);
    const flow = await getFlowOrThrow(lookupClient, sender, flowId);
    enforceRole(auth.party, getRequiredRole('withdraw'), flow.sender, flow.recipient);
    // Withdraw_Flow is controlled by recipient + escrowOperator.
    client = createClientForAuthWithParties(auth, [flow.escrowOperator]);
    const result = await client.withdrawFlow(sender, flowId, {
      settlementReference,
      ...(req.body?.['withdrawTime']
        ? { withdrawTime: new Date(req.body['withdrawTime'] as string) }
        : {}),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'withdrawFlow');
  } finally {
    await lookupClient?.close();
    await client?.close();
  }
});

/** POST /api/flows/:sender/:flowId/stop — mutual termination */
app.post('/api/flows/:sender/:flowId/stop', async (req, res) => {
  let lookupClient: CantonStreamsClient | undefined;
  let client: CantonStreamsClient | undefined;
  try {
    const auth = await authorizeRequest(req, 'stop', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const flowId = requireId(req.params['flowId'], 'flowId');
    const recipientSettlement = requireNonNegativeAmount(
      req.body?.['recipientSettlement'],
      'recipientSettlement',
    );
    const senderRefund = requireNonNegativeAmount(req.body?.['senderRefund'], 'senderRefund');
    const recipientSettlementReference = optionalId(
      req.body?.['recipientSettlementReference'],
      'recipientSettlementReference',
    );
    const senderRefundReference = optionalId(
      req.body?.['senderRefundReference'],
      'senderRefundReference',
    );

    lookupClient = createClientForAuth(auth);
    const flow = await getFlowOrThrow(lookupClient, sender, flowId);
    enforceRole(auth.party, getRequiredRole('stop'), flow.sender, flow.recipient);
    // Stop_Flow is controlled by sender + recipient + escrowOperator.
    client = createClientForAuthWithParties(auth, [
      flow.sender,
      flow.recipient,
      flow.escrowOperator,
    ]);
    const result = await client.stopFlow(sender, flowId, {
      recipientSettlement,
      senderRefund,
      ...(recipientSettlementReference !== undefined ? { recipientSettlementReference } : {}),
      ...(senderRefundReference !== undefined ? { senderRefundReference } : {}),
      ...(req.body?.['stopTime'] ? { stopTime: new Date(req.body['stopTime'] as string) } : {}),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'stopFlow');
  } finally {
    await lookupClient?.close();
    await client?.close();
  }
});

// ---------------------------------------------------------------------------
// Delegated Policy routes
// ---------------------------------------------------------------------------

/** GET /api/policies — list delegated policies visible to the caller */
app.get('/api/policies', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    client = await createAuthorizedClient(req, 'query');
    const policies = await client.listPolicies();
    res.json(serializeForJson(policies));
  } catch (err) {
    handleError(res, err, 'listPolicies');
  } finally {
    await client?.close();
  }
});

/** POST /api/policies/:contractId/revoke — revoke a delegated policy */
app.post('/api/policies/:contractId/revoke', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    // Read both the client and resolved caller party from auth so this
    // route does not depend on X-Canton-Party being present.
    const authorized = await createAuthorizedClientWithParty(req, 'cancel');
    client = authorized.client;
    const callerParty = authorized.party;
    const contractId = requireId(req.params['contractId'], 'contractId');

    // Load the policy first, then assert the caller is the sender (only
    // party authorized to revoke
    // per the Daml template's controller list).
    const policies = await client.listPolicies();
    const policy = policies.find((p) => p.contractId === contractId);
    if (!policy) {
      res.status(404).json({ error: 'policy not found or not visible to caller' });
      return;
    }
    if (!callerParty) {
      res.status(400).json({
        error: 'unresolved_caller_party',
        reason: 'auth layer returned an empty party — check JWT party/sub claim',
      });
      return;
    }
    if (policy.sender !== callerParty) {
      res.status(403).json({
        error: 'forbidden',
        reason: 'Only the policy sender can revoke it',
      });
      return;
    }

    const result = await client.revokePolicy(contractId);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'revokePolicy');
  } finally {
    await client?.close();
  }
});

/** GET /api/execution-logs — list execution audit logs */
app.get('/api/execution-logs', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    client = await createAuthorizedClient(req, 'query');
    const policyId = req.query['policyId'] as string | undefined;
    const logs = await client.listExecutionLogs(policyId);
    res.json(serializeForJson(logs));
  } catch (err) {
    handleError(res, err, 'listExecutionLogs');
  } finally {
    await client?.close();
  }
});

// ---------------------------------------------------------------------------
// Structured error handler
// ---------------------------------------------------------------------------

function handleError(res: express.Response, err: unknown, operation: string): void {
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({
      error: err.message,
      reason: err.reason,
    });
    return;
  }
  const status = (err as any)?.statusCode ?? 500;
  // Always log the full error server-side with a correlation id.
  const correlationId = `${operation}-${Date.now().toString(36)}`;
  console.error(`[${correlationId}] ${operation} error:`, err);
  // For 5xx, do NOT echo the raw upstream/ledger error message to the
  // client — it can carry internal hostnames, gRPC endpoints, request
  // payloads, or token-adjacent fields useful for reconnaissance. Return a
  // generic message plus the correlation id so an operator can find the
  // detail in the logs. Client errors (4xx) keep their actionable message.
  const isServerError = status >= 500;
  res.status(status).json({
    error: isServerError
      ? `Internal error (ref ${correlationId})`
      : err instanceof Error
        ? err.message
        : 'Request error',
    reason: status === 403 ? 'forbidden' : isServerError ? 'internal_error' : 'request_error',
    correlationId,
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    status: startupReadiness?.status === 'degraded' ? 'degraded' : 'ok',
    canton: { host: CANTON_HOST, port: CANTON_PORT },
    readiness: startupReadiness,
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    validateTemplateRegistry({ requireUtility: true, requirePolicy: true });
  } catch (err) {
    console.warn('Template registry validation warning:', (err as Error).message);
    console.warn('Some settlement modes may not be available until DARs are deployed.');
  }

  const readinessConfig = createReadinessConfig(process.env, authConfig.serviceToken ?? undefined);
  startupReadiness = await runStartupReadinessChecks(readinessConfig);

  if (startupReadiness.status === 'degraded') {
    logger.error({ readiness: startupReadiness }, 'Startup readiness checks failed');
    process.exit(1);
  }

  logger.info({ readiness: startupReadiness }, 'Startup readiness checks completed');

  if (autoWithdrawConfig.enabled) {
    if (!authConfig.serviceToken || !authConfig.escrowOperator) {
      throw new AuthError(
        503,
        'token_standard_auto_withdraw_not_configured',
        'Token-standard auto-withdraw requires PROXY_SERVICE_TOKEN and PROXY_ESCROW_OPERATOR',
      );
    }

    const autoWithdrawDiscoveryParties =
      autoWithdrawConfig.discoveryParties.length > 0
        ? [...autoWithdrawConfig.discoveryParties]
        : [
            ...new Set(
              [
                ...(authConfig.userParties ? [...authConfig.userParties] : []),
                ...(authConfig.serviceParties ? [...authConfig.serviceParties] : []),
                authConfig.escrowOperator,
              ].filter(Boolean),
            ),
          ];

    const effectiveAutoWithdrawConfig = {
      ...autoWithdrawConfig,
      discoveryParties: autoWithdrawDiscoveryParties,
      jsonApiToken: autoWithdrawConfig.jsonApiToken ?? authConfig.serviceToken ?? undefined,
      synchronizerId: autoWithdrawConfig.synchronizerId ?? CANTON_SYNCHRONIZER_ID,
    };

    if (
      effectiveAutoWithdrawConfig.interactiveEnabled &&
      (!effectiveAutoWithdrawConfig.jsonApiUrl || !effectiveAutoWithdrawConfig.serviceUserId)
    ) {
      throw new AuthError(
        503,
        'token_standard_auto_withdraw_interactive_not_configured',
        'Interactive token-standard auto-withdraw requires CANTON_JSON_API_URL and PROXY_SERVICE_USER_ID (or SERVICE_USER_ID)',
      );
    }

    const autoWithdrawClientConfig: ClientConfig = {
      host: CANTON_HOST,
      port: CANTON_PORT,
      useTls: CANTON_USE_TLS,
      synchronizerId: CANTON_SYNCHRONIZER_ID,
      token: authConfig.serviceToken,
      actAs: [authConfig.escrowOperator],
      readAs: autoWithdrawDiscoveryParties,
    };

    stopAutoWithdrawWorker = startTokenStandardAutoWithdrawWorker(
      effectiveAutoWithdrawConfig,
      () =>
        runTokenStandardAutoWithdrawCycle(
          autoWithdrawClientConfig,
          orchestrator,
          authConfig.escrowOperator!,
          logger,
          effectiveAutoWithdrawConfig,
        ),
      logger,
    );

    logger.info(
      {
        pollIntervalMs: effectiveAutoWithdrawConfig.pollIntervalMs,
        interactiveEnabled: effectiveAutoWithdrawConfig.interactiveEnabled,
        hostWalletAdapter: effectiveAutoWithdrawConfig.hostWalletAdapter,
        discoveryParties: effectiveAutoWithdrawConfig.discoveryParties,
        escrowOperator: authConfig.escrowOperator,
      },
      'Token-standard auto-withdraw worker enabled',
    );
  }

  app.listen(PROXY_PORT, () => {
    console.log(`Canton Streams proxy listening on :${PROXY_PORT}`);
    console.log(`  Canton participant: ${CANTON_HOST}:${CANTON_PORT} (TLS: ${CANTON_USE_TLS})`);
    if (CANTON_SYNCHRONIZER_ID) {
      console.log(`  Synchronizer: ${CANTON_SYNCHRONIZER_ID}`);
    }
    logAuthConfig(authConfig);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAutoWithdrawWorker?.();
  });
}

void start().catch((err) => {
  logger.error({ err }, 'Proxy failed to start');
  process.exit(1);
});
