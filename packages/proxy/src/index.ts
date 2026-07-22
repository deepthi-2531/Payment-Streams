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
import {
  parseV1LaneConfig,
  V1LaneService,
  V1LaneError,
  type CreateV1StreamInput,
} from './v1-lane.js';
import {
  listStreamsViaJson,
  getStreamViaJson,
  getFlowViaJson,
  listPendingRequestsViaJson,
  listFlowsViaJson,
  listPoliciesViaJson,
  listExecutionLogsViaJson,
  synthesizeStreamHistory,
} from './v2-read.js';
import {
  createStreamAdminViaJson,
  revokePolicyViaJson,
  vestingModeToDaJson,
  createFlowAdminViaJson,
  topUpFlowAdminViaJson,
  syncIterationFlowViaJson,
  markCancelledFlowAdminViaJson,
} from './v2-write.js';
import { getSupportedAssets } from './assets.js';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env['PROXY_PORT'] ?? '4000', 10);
const CANTON_HOST = process.env['CANTON_HOST'] ?? 'localhost';
const CANTON_PORT = parseInt(process.env['CANTON_PORT'] ?? '6865', 10);
const CANTON_USE_TLS = process.env['CANTON_USE_TLS'] === 'true';
// Allow forwarding a bearer token over a plaintext gRPC channel to the
// participant. Default false (SEC hardening). Set true ONLY on a trusted
// private network — here the participant is on the validator's internal docker
// network and its ledger-API auth is disabled, so the token is unused there.
const CANTON_ALLOW_INSECURE_TOKEN = process.env['CANTON_ALLOW_INSECURE_TOKEN'] === 'true';
const CANTON_SYNCHRONIZER_ID = process.env['CANTON_SYNCHRONIZER_ID'];
const autoWithdrawConfig = parseAutoWithdrawConfig(process.env);

/** Auth configuration parsed from environment. */
const authConfig: AuthConfig = parseAuthConfig();
// Fail closed at boot: refuse to start with a spoofable dev-auth
// posture unless it is explicitly acknowledged AND loopback-bound.
assertAuthConfigSafe(authConfig);

/**
 * V1 transfer-instruction lane service — ports the proven settle/create logic
 * from scripts/interest-stream-scheduler.mjs. Wired from the V1 lane env
 * (CANTON_JSON_API_URL, REGISTRY_API_URL, CC_ADMIN_PARTY, the StreamAdmin
 * template / TransferFactory interface ids, operator/user id) with the spec's
 * defaults. Parallel to the SDK-backed V2 /api/streams group.
 */
const v1Lane = new V1LaneService(parseV1LaneConfig(process.env));
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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
  // No explicit filter → no extra filter. The JSON-Ledger-API reads
  // (v2-read.ts) query `filtersByParty[caller]`, so the ledger's own
  // visibility already scopes results to streams where the caller is a
  // stakeholder (sender OR recipient) — both directions, no leakage. (The
  // old gRPC path defaulted to recipient-scoped because it couldn't express
  // "sender OR recipient" in one filter; that's no longer needed.)
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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

    // gRPC read is not functional on this deploy — read over JSON (v2-read.ts).
    let requests = await listPendingRequestsViaJson(authed.party);
    if (filter.sender) requests = requests.filter((r: any) => r.config?.sender === filter.sender);
    if (filter.recipient) requests = requests.filter((r: any) => r.config?.recipient === filter.recipient);
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

    // The SDK gRPC read path is not functional on this deploy (see v2-read.ts);
    // read StreamAdmin over the JSON Ledger API instead, scoped to the caller.
    const streams = await listStreamsViaJson(authed.party, filter);
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
    // gRPC read is not functional on this deploy — read over JSON (v2-read.ts).
    const stream = await getStreamViaJson(
      authed.party,
      req.params['sender']!,
      req.params['streamId']!,
    );
    if (!stream) {
      // Graceful 404 (not a 500) so a missing stream doesn't wall the detail
      // page in a red error.
      res.status(404).json({ error: 'stream not found', reason: 'stream_not_found' });
      return;
    }
    const cfg = stream['config'] as { sender?: string; recipient?: string };
    // A specific stream is only readable by its participants (or a
    // configured operator-reader).
    const isParticipant = cfg.sender === authed.party || cfg.recipient === authed.party;
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
    // gRPC read is not functional on this deploy — read over JSON + synthesize
    // history from current state (v2-read.ts).
    const stream = await getStreamViaJson(
      authed.party,
      req.params['sender']!,
      req.params['streamId']!,
    );
    if (!stream) {
      res.json([]);
      return;
    }
    const cfg = stream['config'] as { sender?: string; recipient?: string };
    const isParticipant = cfg.sender === authed.party || cfg.recipient === authed.party;
    if (!isParticipant && !OPERATOR_READERS.has(authed.party)) {
      throw new AuthError(
        403,
        'read_scope_violation',
        'You may only read a stream where you are the sender or recipient.',
      );
    }
    const events = synthesizeStreamHistory(stream);
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
    // gRPC submit is not functional on this deploy — create the StreamAdmin
    // over the JSON Ledger API (v2-write.ts; proven working).
    const instrumentAdmin = params.instrumentRef?.issuer ?? process.env['CC_ADMIN_PARTY'] ?? '';
    if (!instrumentAdmin) {
      throw new AuthError(400, 'missing_instrument', 'instrumentRef.issuer (or CC_ADMIN_PARTY) is required to create a stream');
    }
    const created = await createStreamAdminViaJson({
      streamId: params.streamId,
      sender: params.sender,
      recipient: params.recipient,
      operator: params.escrowOperator ?? params.sender,
      instrumentAdmin,
      instrumentId: params.instrumentRef?.instrumentId ?? 'Amulet',
      totalDeposited: params.totalDeposited.toString(),
      vestingMode: vestingModeToDaJson(params.vestingMode),
      startTime: params.startTime,
      endTime: params.endTime,
      cancellable: params.cancellable ?? false,
    });
    res.status(201).json({
      requestContractId: created.updateId,
      updateId: created.updateId,
      streamId: params.streamId,
    });
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
// V1 transfer-instruction lane routes (/api/v1/streams)
//
// Parallel to the SDK-backed V2 /api/streams group above; does NOT touch the
// gRPC client. The settle path is the proven scheduler code (ported in
// v1-lane.ts). It supports two V1 modes:
//   1. direct delivery: payer holds unlocked Amulet/CC and pays each cycle via
//      TransferFactory_Transfer; and
//   2. receiver-claim: payer funds a V1 Allocation + ReceiverClaimV1 once, then
//      the recipient claims after unlockAt. This second mode needs the V1 shim
//      DAR vetted on the payer participant, so it is for controlled validators,
//      not arbitrary hosted-wallet participants.
// An optional on-ledger StreamAdmin contract remains the per-stream
// observability record, advanced per settled cycle via Sync_Iteration.
// ---------------------------------------------------------------------------

/** POST /api/v1/streams — create a V1 stream (agreement row + optional StreamAdmin). */
app.post('/api/v1/streams', async (req, res) => {
  try {
    // Reuse the existing user-auth + sender-role enforcement: the caller must
    // be the payer (the on-chain sender for both transfer and Sync_Iteration).
    const auth = await authorizeRequest(req, 'create', authConfig);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const payerParty = (body['payerParty'] as string | undefined)
      ?? (body['sender'] as string | undefined)
      ?? auth.party;
    enforceRole(auth.party, getRequiredRole('create'), payerParty);

    const input: CreateV1StreamInput = {
      streamId: (body['streamId'] as string | undefined) ?? (body['id'] as string | undefined),
      appId: body['appId'] as string | undefined,
      payerParty,
      recipientParty: (body['recipientParty'] as string | undefined)
        ?? (body['recipient'] as string | undefined)
        ?? '',
      ratePerCycle: body['ratePerCycle'] as string | undefined,
      amount: body['amount'] as string | undefined,
      cadence: body['cadence'] as CreateV1StreamInput['cadence'],
      effectiveFrom: body['effectiveFrom'] as string | undefined,
      termEnd: body['termEnd'] as string | undefined,
      arrearsPolicy: body['arrearsPolicy'] as CreateV1StreamInput['arrearsPolicy'],
      totalDeposited: body['totalDeposited'] as string | undefined,
      createAdminRecord: body['createAdminRecord'] === true,
      cancellable: body['cancellable'] as boolean | undefined,
      observers: body['observers'] as string[] | undefined,
    };

    const view = await v1Lane.createStream(input);
    res.status(201).json(serializeForJson(view));
  } catch (err) {
    handleError(res, err, 'createV1Stream');
  }
});

/** GET /api/v1/streams — list V1 streams (proxy state + on-ledger StreamAdmin progress). */
app.get('/api/v1/streams', async (req, res) => {
  try {
    // Scope the listing to the caller: only streams where they are payer or
    // recipient are returned, so one wallet can't enumerate another's streams.
    const auth = await authorizeRequest(req, 'query', authConfig);
    const streams = await v1Lane.listStreams(auth.party);
    res.json(serializeForJson(streams));
  } catch (err) {
    handleError(res, err, 'listV1Streams');
  }
});

/** GET /api/v1/streams/:id — V1 stream detail incl. settled cycles + on-ledger record. */
app.get('/api/v1/streams/:id', async (req, res) => {
  try {
    // Only the payer or recipient may read a V1 stream's terms/history.
    const auth = await authorizeRequest(req, 'query', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    res.json(serializeForJson(view));
  } catch (err) {
    handleError(res, err, 'getV1Stream');
  }
});

/** POST /api/v1/streams/:id/settle — trigger one settle cycle now (on-demand). */
app.post('/api/v1/streams/:id/settle', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    // Read-scope check first (payer or recipient); then restrict settle to payer.
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    // Only the payer may move money out of their own wallet.
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.settle(req.params['id']!, {
      force: body['force'] === true,
      amount: body['amount'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'settleV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/stop — halt a stream. Only the payer (sender) may
 * stop their own stream; accrual + settlement cease immediately.
 */
app.post('/api/v1/streams/:id/stop', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const result = await v1Lane.stopStream(req.params['id']!);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'stopV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/prepare-settle — model 2 (wallet-submitted settle).
 * Forms the cycle's TransferFactory_Transfer (registry choice-context needs the
 * whitelisted egress, so it must happen here) and returns the ready-to-submit
 * command + disclosed contracts for the payer's WALLET to submit through its own
 * participant. Nothing is settled until POST /record-settle confirms the commit.
 */
app.post('/api/v1/streams/:id/prepare-settle', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareSettle(req.params['id']!, {
      force: body['force'] === true,
      amount: body['amount'] as string | undefined,
      holdings: body['holdings'] as { cid: string; amount: number }[] | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareSettleV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/record-settle — model 2 phase 2. Records a cycle the
 * payer's wallet already committed (idempotent on updateId).
 */
app.post('/api/v1/streams/:id/record-settle', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.recordSettle(req.params['id']!, {
      updateId: body['updateId'] as string,
      amount: body['amount'] as string,
      ref: body['ref'] as string | undefined,
      executeBefore: body['executeBefore'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recordSettleV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/recover-pending — self-heal a settle that committed
 * on-ledger but whose record was lost (e.g. the payer's wallet threw a false
 * rejection after the transfer committed). Records any active, untracked offer.
 */
app.post('/api/v1/streams/:id/recover-pending', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const result = await v1Lane.recoverPendingOffers(req.params['id']!);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recoverPendingV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/prepare-allocation — receiver-claim phase 1.
 * Forms AllocationFactory_Allocate for Alice's wallet. By default the proxy
 * sets executor == recipient so Bob can later claim solo from his wallet.
 */
app.post('/api/v1/streams/:id/prepare-allocation', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareReceiverAllocation(req.params['id']!, {
      force: body['force'] === true,
      amount: body['amount'] as string | undefined,
      holdings: body['holdings'] as { cid: string; amount: number }[] | undefined,
      executor: body['executor'] as string | undefined,
      unlockAt: body['unlockAt'] as string | undefined,
      expiresAt: body['expiresAt'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareAllocationV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/record-allocation — receiver-claim phase 2.
 * Records the Allocation cid Alice's wallet created. The caller supplies the
 * cid because hosted wallet submit responses do not reliably expose created
 * contract ids.
 */
app.post('/api/v1/streams/:id/record-allocation', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.recordReceiverAllocation(req.params['id']!, {
      allocationCid: body['allocationCid'] as string,
      allocationUpdateId: body['allocationUpdateId'] as string | undefined,
      amount: body['amount'] as string,
      ref: body['ref'] as string | undefined,
      cycle: Number(body['cycle']),
      executor: body['executor'] as string | undefined,
      unlockAt: body['unlockAt'] as string,
      expiresAt: body['expiresAt'] as string,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recordAllocationV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/prepare-receiver-claim — receiver-claim phase 3.
 * Builds the ReceiverClaimV1 create command for Alice's wallet. This is the
 * sender's one-time consent that lets Bob claim later without Alice.
 */
app.post('/api/v1/streams/:id/prepare-receiver-claim', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareReceiverClaim(req.params['id']!, {
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
      allocationCid: body['allocationCid'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareReceiverClaimV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/record-receiver-claim — receiver-claim phase 4.
 * Records the ReceiverClaimV1 cid Alice's wallet created.
 */
app.post('/api/v1/streams/:id/record-receiver-claim', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.recordReceiverClaim(req.params['id']!, {
      receiverClaimCid: body['receiverClaimCid'] as string,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
      allocationCid: body['allocationCid'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recordReceiverClaimV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/prepare-claim — receiver-claim phase 5.
 * Fetches the live registry execute-transfer choice-context/disclosures and
 * returns Bob's ready-to-submit ReceiverClaimV1.Claim command.
 */
app.post('/api/v1/streams/:id/prepare-claim', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'recipient', view.agreement.payerParty, view.agreement.recipientParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareClaim(req.params['id']!, {
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
      allocationCid: body['allocationCid'] as string | undefined,
      receiverClaimCid: body['receiverClaimCid'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareClaimV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/record-claim — receiver-claim phase 6.
 * Records Bob's wallet-submitted claim only after Scan confirms the update.
 */
app.post('/api/v1/streams/:id/record-claim', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'recipient', view.agreement.payerParty, view.agreement.recipientParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.recordClaim(req.params['id']!, {
      updateId: body['updateId'] as string,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
      allocationCid: body['allocationCid'] as string | undefined,
      receiverClaimCid: body['receiverClaimCid'] as string | undefined,
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recordClaimV1Stream');
  }
});

// ---------------------------------------------------------------------------
// Pending-offer lane (TransferInstruction Accept / Withdraw)
//
// Direct-delivery (preapproval) settles via /record-settle, which classifies
// the on-chain outcome from the Scan update: a settle that landed as a pending
// TransferInstruction is recorded as a pending offer (not "settled"). The
// recipient accepts it from their own wallet; the sender can withdraw/retry
// after expiry.
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/streams/:id/prepare-accept — recipient accepts a pending offer.
 * Forms TransferInstruction_Accept (registry choice-context + disclosures).
 */
app.post('/api/v1/streams/:id/prepare-accept', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'recipient', view.agreement.payerParty, view.agreement.recipientParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareAcceptTransfer(req.params['id']!, {
      transferInstructionCid: body['transferInstructionCid'] as string | undefined,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareAcceptV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/record-accept — record the recipient's accepted
 * transfer only after Scan confirms it committed. Advances settled/cycles.
 */
app.post('/api/v1/streams/:id/record-accept', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'recipient', view.agreement.payerParty, view.agreement.recipientParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.recordAcceptTransfer(req.params['id']!, {
      updateId: body['updateId'] as string,
      transferInstructionCid: body['transferInstructionCid'] as string | undefined,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recordAcceptV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/accept — model-1 hosted/dev-mode accept. The proxy
 * SUBMITS TransferInstruction_Accept on behalf of a recipient hosted on this
 * participant (no browser wallet, e.g. a validator-local party). Recipient-
 * scoped + Scan-verified, same proof bar as the wallet accept.
 */
app.post('/api/v1/streams/:id/accept', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'recipient', view.agreement.payerParty, view.agreement.recipientParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.acceptTransferHosted(req.params['id']!, {
      transferInstructionCid: body['transferInstructionCid'] as string | undefined,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'acceptHostedV1Stream');
  }
});

/**
 * GET /api/v1/received — ledger-backed incoming view for the caller party:
 * pending offers awaiting accept + CC already delivered. Independent of the
 * proxy JSON store, so it surfaces transfers the proxy never created (raw
 * registry or wallet-sent) that the stream list cannot show.
 */
app.get('/api/v1/received', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'query', authConfig);
    const view = await v1Lane.listReceived(auth.party);
    res.json(serializeForJson(view));
  } catch (err) {
    handleError(res, err, 'listV1Received');
  }
});

/**
 * POST /api/v1/received/accept — recipient accepts a pending incoming offer by
 * contract id (model-1 hosted/dev-mode). The proxy submits
 * TransferInstruction_Accept as the caller; the ledger enforces the caller is
 * the offer's receiver, and the proxy only surfaces offers addressed to them.
 */
app.post('/api/v1/received/accept', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.acceptReceived(auth.party, body['transferInstructionCid'] as string);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'acceptV1Received');
  }
});

/**
 * POST /api/v1/received/prepare-accept — model-2 (wallet) counterpart: returns
 * the TransferInstruction_Accept command + disclosed contracts for the caller's
 * WALLET to sign and submit on its own participant. Needed when the recipient is
 * NOT hosted on the proxy's participant (e.g. a Loop wallet party), so the proxy
 * can't submit for it but can still build the registry choice-context.
 */
app.post('/api/v1/received/prepare-accept', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareAcceptReceived(auth.party, body['transferInstructionCid'] as string);
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareAcceptV1Received');
  }
});

/**
 * POST /api/v1/streams/:id/prepare-withdraw — sender reclaims a pending
 * (unaccepted) offer. Forms TransferInstruction_Withdraw.
 */
app.post('/api/v1/streams/:id/prepare-withdraw', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.prepareWithdrawTransfer(req.params['id']!, {
      transferInstructionCid: body['transferInstructionCid'] as string | undefined,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'prepareWithdrawV1Stream');
  }
});

/**
 * POST /api/v1/streams/:id/record-withdraw — record the sender's withdrawal
 * once Scan confirms it. Marks the offer reclaimed (settled is NOT advanced).
 */
app.post('/api/v1/streams/:id/record-withdraw', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'create', authConfig);
    const view = await v1Lane.getStream(req.params['id']!, auth.party);
    enforceRole(auth.party, 'sender', view.agreement.payerParty);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await v1Lane.recordWithdrawTransfer(req.params['id']!, {
      updateId: body['updateId'] as string,
      transferInstructionCid: body['transferInstructionCid'] as string | undefined,
      cycle: body['cycle'] === undefined ? undefined : Number(body['cycle']),
    });
    res.json(serializeForJson(result));
  } catch (err) {
    handleError(res, err, 'recordWithdrawV1Stream');
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

    // gRPC read is not functional on this deploy — read over JSON (v2-read.ts).
    let flows = await listFlowsViaJson(authed.party);
    if (filter.sender) flows = flows.filter((f: any) => f.sender === filter.sender);
    if (filter.recipient) flows = flows.filter((f: any) => f.recipient === filter.recipient);
    if (filter.status) flows = flows.filter((f: any) => f.status === filter.status);
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

    // gRPC submit is not functional on this deploy — create the StreamFlowAdmin
    // over the JSON Ledger API (v2-write.ts). It is `signatory sender`, so
    // actAs=[sender] suffices.
    const streamId = params.streamId ?? `flow-${Date.now()}`;
    const created = await createFlowAdminViaJson({
      streamId,
      sender: params.sender,
      recipient: params.recipient,
      operator: escrowOperator,
      instrumentAdmin: params.instrumentRef.issuer,
      instrumentId: params.instrumentRef.instrumentId,
      flowRate: params.flowRate.toString(),
      initialFundedAmount: params.fundedAmount.toString(),
      startTime: params.startTime ?? new Date(),
    });
    res.status(201).json({ updateId: created.updateId, streamId });
  } catch (err) {
    handleError(res, err, 'createFlow');
  } finally {
    await client?.close();
  }
});

/** POST /api/flows/:sender/:flowId/top-up — sender adds to the funded balance */
app.post('/api/flows/:sender/:flowId/top-up', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'top-up', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const flowId = requireId(req.params['flowId'], 'flowId');
    // Enforce: caller must be the sender (top-up is sender-only)
    enforceRole(auth.party, getRequiredRole('top-up'), sender);
    const topUpAmount = requireAmount(req.body?.['topUpAmount'], 'topUpAmount');
    const newAllocationCid = optionalId(req.body?.['settlementReference'], 'settlementReference');

    const flow = await getFlowViaJson(auth.party, sender, flowId);
    if (!flow) {
      throw new AuthError(404, 'flow_not_found', `Flow not found: sender=${sender}, flowId=${flowId}`);
    }
    // TopUp_Flow_Admin is controller operator — bookkeeping over JSON.
    const result = await topUpFlowAdminViaJson(
      flow.contractId as string,
      flow.escrowOperator as string,
      topUpAmount.toString(),
      newAllocationCid,
    );
    res.json({ ...result, flowId });
  } catch (err) {
    handleError(res, err, 'topUpFlow');
  }
});

/** POST /api/flows/:sender/:flowId/withdraw — record a settle iteration */
app.post('/api/flows/:sender/:flowId/withdraw', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'withdraw', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const flowId = requireId(req.params['flowId'], 'flowId');
    const newAllocationCid = optionalId(req.body?.['settlementReference'], 'settlementReference');
    const iterationAmount = optionalAmount(req.body?.['settledAmount'], 'settledAmount');

    const flow = await getFlowViaJson(auth.party, sender, flowId);
    if (!flow) {
      throw new AuthError(404, 'flow_not_found', `Flow not found: sender=${sender}, flowId=${flowId}`);
    }
    enforceRole(auth.party, getRequiredRole('withdraw'), flow.sender as string, flow.recipient as string);
    // Sync_Iteration_Flow (controller operator) advances the admin index. The
    // Amulet money leg (Allocation_Settle) is DSO-gated on this participant, so
    // this records the iteration only — funds are not moved here.
    const result = await syncIterationFlowViaJson(
      flow.contractId as string,
      flow.escrowOperator as string,
      (iterationAmount ?? 0).toString(),
      newAllocationCid,
    );
    res.json({
      ...result,
      flowId,
      settlementNote: 'admin iteration recorded; Amulet Allocation_Settle is DSO-gated on this participant',
    });
  } catch (err) {
    handleError(res, err, 'withdrawFlow');
  }
});

/** POST /api/flows/:sender/:flowId/stop — mark the flow cancelled */
app.post('/api/flows/:sender/:flowId/stop', async (req, res) => {
  try {
    const auth = await authorizeRequest(req, 'stop', authConfig);
    const sender = requirePartyId(req.params['sender'], 'sender');
    const flowId = requireId(req.params['flowId'], 'flowId');
    const releasedAllocationCid = optionalId(
      req.body?.['senderRefundReference'] ?? req.body?.['recipientSettlementReference'],
      'releasedAllocationCid',
    );

    const flow = await getFlowViaJson(auth.party, sender, flowId);
    if (!flow) {
      throw new AuthError(404, 'flow_not_found', `Flow not found: sender=${sender}, flowId=${flowId}`);
    }
    enforceRole(auth.party, getRequiredRole('stop'), flow.sender as string, flow.recipient as string);
    // Mark_Cancelled_Flow_Admin (controller operator). finalWithdrawn must be
    // >= current totalWithdrawn and <= funded — hold at the current recorded
    // total (the Amulet Allocation_Cancel refund is DSO-gated here).
    const result = await markCancelledFlowAdminViaJson(
      flow.contractId as string,
      flow.escrowOperator as string,
      String(flow.totalWithdrawn ?? '0'),
      new Date(),
      releasedAllocationCid,
    );
    res.json({
      ...result,
      flowId,
      settlementNote: 'flow marked cancelled; Amulet Allocation_Cancel refund is DSO-gated on this participant',
    });
  } catch (err) {
    handleError(res, err, 'stopFlow');
  }
});

// ---------------------------------------------------------------------------
// Delegated Policy routes
// ---------------------------------------------------------------------------

/** GET /api/policies — list delegated policies visible to the caller */
app.get('/api/policies', async (req, res) => {
  let client: CantonStreamsClient | undefined;
  try {
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    // gRPC read is not functional on this deploy — read over JSON (v2-read.ts).
    const policies = await listPoliciesViaJson(authed.party);
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
    // party authorized to revoke per the Daml template's controller list).
    // gRPC read is not functional on this deploy — read over JSON.
    const policies = await listPoliciesViaJson(callerParty);
    const policy = policies.find((p: any) => p.contractId === contractId) as
      | { contractId: string; sender: string }
      | undefined;
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

    // gRPC submit is not functional on this deploy — revoke over JSON.
    const result = await revokePolicyViaJson(contractId, callerParty);
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
    const authed = await createAuthorizedClientWithParty(req, 'query');
    client = authed.client;
    const policyId = req.query['policyId'] as string | undefined;
    // gRPC read is not functional on this deploy — read over JSON (v2-read.ts).
    let logs = await listExecutionLogsViaJson(authed.party);
    if (policyId) logs = logs.filter((l: any) => l.policyId === policyId);
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
  if (err instanceof V1LaneError) {
    // Surface the V1 lane's structured reason code, but keep the published
    // 5xx-masking posture: never echo raw upstream/ledger detail to clients.
    const isServerErr = err.statusCode >= 500;
    const correlationId = `${operation}-${Date.now().toString(36)}`;
    if (isServerErr) console.error(`[${correlationId}] ${operation} error:`, err);
    res.status(err.statusCode).json({
      error: isServerErr ? `Internal error (ref ${correlationId})` : err.message,
      reason: err.reason,
      ...(isServerErr ? { correlationId } : {}),
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

/**
 * GET /api/assets — supported assets for the create-stream / create-flow asset
 * picker. Public deployment config (admin parties resolved from the proxy env),
 * no party/auth needed; the picker also offers a "Custom" entry for anything
 * not listed here.
 */
app.get('/api/assets', (_req, res) => {
  res.json(getSupportedAssets());
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
    allowInsecureToken: CANTON_ALLOW_INSECURE_TOKEN,
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
