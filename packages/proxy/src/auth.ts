/**
 * Proxy authorization module — production JWT-bound auth.
 *
 * Enforces two auth tiers:
 *
 * 1. **User auth** — browser clients send a Bearer JWT. In production (`jwt`
 *    mode), the proxy verifies the JWT signature via JWKS, validates issuer /
 *    audience / expiry, extracts the party claim, and checks it against the
 *    `X-Canton-Party` header (must match).
 *
 * 2. **Service auth** — the escrow operator / executor uses a separate service
 *    token (server-side, never exposed to clients). Service routes like
 *    /finalize accept only the service token and submit with all required
 *    signatories in actAs.
 *
 * Per-route role enforcement:
 *   Each route declares which party role the caller must hold (sender,
 *   recipient, participant, any). The proxy validates this at the route level,
 *   not "checked at SDK level."
 *
 * Environment variables:
 *   PROXY_USER_PARTIES     — comma-separated parties allowed for user actions
 *   PROXY_SERVICE_PARTIES  — comma-separated parties allowed for service actions
 *   PROXY_SERVICE_TOKEN    — JWT for the service account (escrow operator)
 *   PROXY_ESCROW_OPERATOR  — party ID for the escrow operator service account
 *   PROXY_AUTH_MODE         — "jwt" (production) or "dev" (local dev, trusts X-Canton-Party)
 *   PROXY_OIDC_ISSUER       — OIDC issuer URL for JWKS discovery (required for jwt mode)
 *   PROXY_JWT_ISSUER        — expected JWT issuer claim (falls back to PROXY_OIDC_ISSUER)
 *   PROXY_JWT_AUDIENCE      — expected JWT audience claim (optional)
 *   PROXY_JWT_PARTY_CLAIM   — custom JWT claim path for party ID (default: tries "party", then "sub")
 */

import type { Request } from 'express';
import * as jose from 'jose';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string equality. Returns false for length mismatches
 * without timing leakage on the compared bytes.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Action definitions
// ---------------------------------------------------------------------------

/**
 * Every proxy route maps to exactly one action. The action determines:
 * - which auth tier is required (user vs service)
 * - which party role the caller must hold relative to the stream
 */
export type Action =
  | 'create'
  | 'accept'
  | 'withdraw'
  | 'cancel'
  | 'mutual-cancel'
  | 'renew'
  | 'top-up'
  | 'stop'
  | 'query'
  | 'finalize';

/**
 * Which party role the caller must hold for the given action.
 * - sender: caller party must match the stream's sender
 * - recipient: must match the stream's recipient
 * - participant: must be either sender or recipient
 * - any: no stream-level check (used for queries and initial create)
 */
export type RequiredRole = 'sender' | 'recipient' | 'participant' | 'any';

interface ActionSpec {
  tier: 'user' | 'service';
  role: RequiredRole;
}

const ACTION_SPECS: Record<Action, ActionSpec> = {
  create:          { tier: 'user',    role: 'sender' },
  accept:          { tier: 'user',    role: 'recipient' },
  withdraw:        { tier: 'user',    role: 'recipient' },
  cancel:          { tier: 'user',    role: 'sender' },
  'mutual-cancel': { tier: 'user',    role: 'participant' },
  renew:           { tier: 'user',    role: 'sender' },
  'top-up':        { tier: 'user',    role: 'sender' },
  stop:            { tier: 'user',    role: 'participant' },
  query:           { tier: 'user',    role: 'any' },
  finalize:        { tier: 'service', role: 'any' },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AuthMode = 'jwt' | 'dev';

export interface AuthConfig {
  /** Effective auth mode after the fail-closed downgrade: "jwt"
   * (production) or "dev" (local, trusts X-Canton-Party). Dev only
   * survives when `devAuthAcknowledged` is true. */
  mode: AuthMode;
  /** What PROXY_AUTH_MODE actually requested, before the safety
   * downgrade. Used by `assertAuthConfigSafe` to detect a dev request
   * that lacks the explicit acknowledgement. */
  requestedMode: AuthMode;
  /** True iff PROXY_ALLOW_DEV_AUTH=true. Dev mode requires this. */
  devAuthAcknowledged: boolean;
  /** True iff PROXY_ALLOW_ANY_AUDIENCE=true. jwt mode without an expected
   * audience requires this acknowledgement; otherwise the proxy refuses
   * to start (a token minted for another relying party on the same IdP
   * would otherwise be accepted). */
  audienceUnenforcedAcknowledged: boolean;
  /** Parties allowed user-level actions. null = open access. */
  userParties: Set<string> | null;
  /** Parties allowed service-level actions. null = open access. */
  serviceParties: Set<string> | null;
  /** Bearer token for the service account (escrow operator). */
  serviceToken: string | null;
  /** Party ID for the escrow operator. */
  escrowOperator: string | null;
  /** Expected JWT issuer. */
  jwtIssuer: string | null;
  /** Expected JWT audience. */
  jwtAudience: string | null;
  /** OIDC issuer URL for JWKS discovery (jwt mode). */
  oidcIssuer: string | null;
  /** Custom JWT claim for party ID (default: tries "party", then "sub"). */
  jwtPartyClaim: string | null;
}

/**
 * Cached JWKS key set — initialized once on first jwt-mode request
 * via OIDC discovery.
 */
let cachedJwks: jose.FlattenedJWSInput extends never ? never : ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let jwksInitPromise: Promise<void> | null = null;

/** Parse auth config from environment variables. */
export function parseAuthConfig(): AuthConfig {
  // Fail closed. The proxy moves funds, so identity must never be
  // derived from an unverified token or a client header by default. The
  // auth mode now defaults to 'jwt' (full JWKS verification). Dev mode —
  // which trusts X-Canton-Party and mints Canton JWTs for arbitrary
  // parties — is only honoured when the operator EXPLICITLY acknowledges
  // it with PROXY_ALLOW_DEV_AUTH=true. Setting PROXY_AUTH_MODE=dev without
  // that flag is treated as a misconfiguration and rejected at startup
  // (see assertAuthConfigSafe).
  const requestedMode = (process.env['PROXY_AUTH_MODE'] ?? 'jwt') as AuthMode;
  const devAuthAcknowledged = process.env['PROXY_ALLOW_DEV_AUTH'] === 'true';
  const mode: AuthMode =
    requestedMode === 'dev' && devAuthAcknowledged ? 'dev' : 'jwt';
  const oidcIssuer = process.env['PROXY_OIDC_ISSUER'] ?? null;
  return {
    mode,
    requestedMode,
    devAuthAcknowledged,
    audienceUnenforcedAcknowledged: process.env['PROXY_ALLOW_ANY_AUDIENCE'] === 'true',
    userParties: parsePartySet(process.env['PROXY_USER_PARTIES']),
    serviceParties: parsePartySet(process.env['PROXY_SERVICE_PARTIES']),
    serviceToken: process.env['PROXY_SERVICE_TOKEN'] ?? null,
    escrowOperator: process.env['PROXY_ESCROW_OPERATOR'] ?? null,
    jwtIssuer: process.env['PROXY_JWT_ISSUER'] ?? oidcIssuer,
    jwtAudience: process.env['PROXY_JWT_AUDIENCE'] ?? null,
    oidcIssuer,
    jwtPartyClaim: process.env['PROXY_JWT_PARTY_CLAIM'] ?? null,
  };
}

function parsePartySet(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const parties = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return parties.length > 0 ? new Set(parties) : null;
}

// ---------------------------------------------------------------------------
// Authorization result
// ---------------------------------------------------------------------------

export interface AuthResult {
  /** The acting party extracted from the JWT or header. */
  party: string;
  /** The Bearer token to use for ledger access. */
  token: string | undefined;
  /** Parties to include in actAs for the ledger command. */
  actAs: string[];
}

export class AuthError extends Error {
  statusCode: number;
  reason: string;

  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// JWKS initialization (lazy, once)
// ---------------------------------------------------------------------------

/**
 * Initialize the JWKS key set from the OIDC discovery endpoint.
 * Called lazily on the first jwt-mode request.
 */
async function ensureJwks(config: AuthConfig): Promise<ReturnType<typeof jose.createRemoteJWKSet>> {
  if (cachedJwks) return cachedJwks;

  if (jwksInitPromise) {
    await jwksInitPromise;
    return cachedJwks!;
  }

  jwksInitPromise = (async () => {
    if (!config.oidcIssuer) {
      // No OIDC discovery — fall back to issuer URL for JWKS
      // Try standard JWKS endpoint: {issuer}/.well-known/jwks.json
      const issuerUrl = config.jwtIssuer;
      if (!issuerUrl) {
        throw new AuthError(
          500,
          'jwks_not_configured',
          'PROXY_AUTH_MODE=jwt requires PROXY_OIDC_ISSUER or PROXY_JWT_ISSUER to be set',
        );
      }
      const jwksUrl = new URL('/.well-known/jwks.json', issuerUrl);
      cachedJwks = jose.createRemoteJWKSet(jwksUrl);
      console.log(`  JWKS: using direct URL ${jwksUrl.toString()}`);
      return;
    }

    // OIDC auto-discovery
    const discoveryUrl = `${config.oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    console.log(`  JWKS: fetching OIDC discovery from ${discoveryUrl}`);

    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new AuthError(
        500,
        'oidc_discovery_failed',
        `OIDC discovery failed: ${response.status} ${response.statusText} from ${discoveryUrl}`,
      );
    }

    const discovery = await response.json() as { jwks_uri?: string };
    if (!discovery.jwks_uri) {
      throw new AuthError(
        500,
        'oidc_missing_jwks_uri',
        'OIDC discovery response does not contain jwks_uri',
      );
    }

    cachedJwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri));
    console.log(`  JWKS: cached key set from ${discovery.jwks_uri}`);
  })();

  await jwksInitPromise;
  return cachedJwks!;
}

// ---------------------------------------------------------------------------
// Authorization logic
// ---------------------------------------------------------------------------

/**
 * Authorize a request for the given action.
 *
 * For user actions in jwt mode: verifies JWT signature via JWKS, validates
 * issuer, audience, expiry, extracts the party, and binds to X-Canton-Party.
 *
 * For user actions in dev mode: trusts X-Canton-Party header (local dev only).
 *
 * For service actions: validates the service token from the Authorization header
 * matches the configured PROXY_SERVICE_TOKEN.
 *
 * @throws AuthError if authorization fails
 */
export async function authorizeRequest(
  req: Request,
  action: Action,
  config: AuthConfig,
): Promise<AuthResult> {
  const spec = ACTION_SPECS[action];

  if (spec.tier === 'service') {
    return authorizeServiceRequest(req, config);
  }

  return authorizeUserRequest(req, config);
}

/**
 * Get the required role for an action (used by route handlers
 * to perform stream-level party checks).
 */
export function getRequiredRole(action: Action): RequiredRole {
  return ACTION_SPECS[action].role;
}

/**
 * Validate that the caller's party matches the required role for the stream.
 * Called by route handlers after authorizeRequest.
 *
 * @throws AuthError if the caller doesn't have the required role
 */
export function enforceRole(
  callerParty: string,
  role: RequiredRole,
  streamSender?: string,
  streamRecipient?: string,
): void {
  if (role === 'any') return;

  if (role === 'sender') {
    if (!streamSender || callerParty !== streamSender) {
      throw new AuthError(
        403,
        'role_mismatch',
        `This action requires the sender party, but caller is "${truncateParty(callerParty)}"`,
      );
    }
  } else if (role === 'recipient') {
    if (!streamRecipient || callerParty !== streamRecipient) {
      throw new AuthError(
        403,
        'role_mismatch',
        `This action requires the recipient party, but caller is "${truncateParty(callerParty)}"`,
      );
    }
  } else if (role === 'participant') {
    if (
      (!streamSender || callerParty !== streamSender) &&
      (!streamRecipient || callerParty !== streamRecipient)
    ) {
      throw new AuthError(
        403,
        'role_mismatch',
        `This action requires a stream participant (sender or recipient), but caller is "${truncateParty(callerParty)}"`,
      );
    }
  }
}

async function authorizeUserRequest(req: Request, config: AuthConfig): Promise<AuthResult> {
  const token = extractToken(req);
  let party: string;

  if (config.mode === 'jwt') {
    // Production: verify JWT signature and extract party from verified claims
    if (!token) {
      throw new AuthError(401, 'missing_token', 'Missing Authorization: Bearer <token> header');
    }
    party = await verifyAndExtractParty(token, config);

    // Token-to-party binding: verify the party claim matches X-Canton-Party
    const headerParty = req.headers['x-canton-party'] as string | undefined;
    if (headerParty && headerParty !== party) {
      throw new AuthError(
        403,
        'party_mismatch',
        `JWT party claim "${truncateParty(party)}" does not match X-Canton-Party header "${truncateParty(headerParty)}"`,
      );
    }
  } else {
    // Dev mode: prefer wallet-issued Authorization: Bearer <token> with
    // a `party` or `sub` claim. X-Canton-Party remains as a local script
    // fallback.
    const jwtParty = token ? extractPartyFromJwtUnsafe(token) : null;
    const headerParty = req.headers['x-canton-party'] as string | undefined;
    party = jwtParty ?? headerParty ?? '';
    if (!party) {
      throw new AuthError(
        400,
        'missing_party',
        'Dev mode: provide Authorization: Bearer <jwt-with-party-or-sub-claim>',
      );
    }
  }

  // Check user allowlist
  if (config.userParties && !config.userParties.has(party)) {
    throw new AuthError(
      403,
      'party_not_allowed',
      `Party "${truncateParty(party)}" is not in the user-party allowlist`,
    );
  }

  // In dev mode, if no explicit token was supplied and CANTON_JWT_SECRET is
  // available, generate a Canton HS256 JWT for the acting party.  This lets
  // the proxy authenticate with a remote participant that requires JWTs
  // without the dashboard needing to know the secret.
  const effectiveToken =
    token ?? (config.mode === 'dev' ? generateCantonJwt(party, [party]) : undefined);

  return { party, token: effectiveToken, actAs: [party] };
}

function authorizeServiceRequest(req: Request, config: AuthConfig): AuthResult {
  const token = extractToken(req);

  // Service routes require a configured service token
  if (!config.serviceToken) {
    throw new AuthError(
      503,
      'service_not_configured',
      'Service routes require PROXY_SERVICE_TOKEN to be configured',
    );
  }

  // Validate the request token against the service token with a
  // constant-time comparison. A plain `!==` short-circuits on the first
  // differing byte, leaking the shared secret's prefix length through
  // response timing. `timingSafeEqual` requires equal-length buffers, so
  // guard the length first (a length mismatch is already a non-match and
  // safe to reveal).
  if (!constantTimeEquals(token ?? '', config.serviceToken)) {
    throw new AuthError(
      403,
      'service_token_invalid',
      'This route requires a valid service token',
    );
  }

  if (!config.escrowOperator) {
    throw new AuthError(
      503,
      'service_not_configured',
      'Service routes require PROXY_ESCROW_OPERATOR to be configured',
    );
  }

  return {
    party: config.escrowOperator,
    token: config.serviceToken,
    actAs: [config.escrowOperator],
  };
}

// ---------------------------------------------------------------------------
// JWT verification (production)
// ---------------------------------------------------------------------------

/**
 * Verify a JWT using JWKS and extract the party from its claims.
 *
 * In production mode, this:
 * 1. Fetches the JWKS key set (cached after first call) via OIDC discovery
 * 2. Verifies the JWT signature against the key set
 * 3. Validates issuer, audience, and expiry
 * 4. Extracts the party from claims (configurable claim path)
 *
 * @throws AuthError on any verification failure
 */
async function verifyAndExtractParty(token: string, config: AuthConfig): Promise<string> {
  const jwks = await ensureJwks(config);

  let payload: jose.JWTPayload;
  try {
    const verifyOptions: jose.JWTVerifyOptions = {};
    if (config.jwtIssuer) verifyOptions.issuer = config.jwtIssuer;
    if (config.jwtAudience) verifyOptions.audience = config.jwtAudience;

    const result = await jose.jwtVerify(token, jwks, verifyOptions);
    payload = result.payload;
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) {
      throw new AuthError(401, 'token_expired', 'JWT has expired');
    }
    if (err instanceof jose.errors.JWTClaimValidationFailed) {
      throw new AuthError(401, 'invalid_claims', `JWT claim validation failed: ${(err as Error).message}`);
    }
    if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
      throw new AuthError(401, 'invalid_signature', 'JWT signature verification failed');
    }
    throw new AuthError(401, 'invalid_token', `JWT verification failed: ${(err as Error).message}`);
  }

  // Extract party from claims
  const party = extractPartyFromClaims(payload, config);
  if (!party) {
    throw new AuthError(
      401,
      'missing_party_claim',
      'JWT must contain a party identifier in "sub", "party", or the configured claim path',
    );
  }

  return party;
}

/**
 * Extract the party identifier from verified JWT claims.
 *
 * Supports:
 * 1. Custom claim path (PROXY_JWT_PARTY_CLAIM env var)
 * 2. Standard `party` claim
 * 3. Canton-specific `https://canton.network/party` claim
 * 4. Fallback to `sub` claim
 */
function extractPartyFromClaims(payload: jose.JWTPayload, config: AuthConfig): string | null {
  // Custom claim path takes priority
  if (config.jwtPartyClaim) {
    const value = payload[config.jwtPartyClaim];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  // Standard party claim
  if (typeof payload['party'] === 'string' && payload['party'].length > 0) {
    return payload['party'];
  }

  // Canton-specific namespaced claim
  const cantonClaim = payload['https://canton.network/party'];
  if (typeof cantonClaim === 'string' && cantonClaim.length > 0) {
    return cantonClaim;
  }

  // Fallback to sub
  if (typeof payload['sub'] === 'string' && payload['sub'].length > 0) {
    return payload['sub'];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Legacy JWT decoding (dev mode fallback)
// ---------------------------------------------------------------------------

/**
 * Extract the party from a JWT's payload WITHOUT signature verification.
 *
 * Used only in dev mode or as a diagnostic tool. In production, use
 * verifyAndExtractParty() which performs full JWKS verification.
 *
 * @deprecated Use verifyAndExtractParty for production.
 */
export function extractPartyFromJwtUnsafe(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson);
    return (payload['party'] as string) ?? (payload['sub'] as string) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Legacy helper retained for local scripts that still pass X-Canton-Party.
// The primary dev-auth path reads party from JWT `party`/`sub` claims.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function extractPartyFromHeader(req: Request): string {
  const party = req.headers['x-canton-party'] as string | undefined;
  if (!party) {
    throw new AuthError(400, 'missing_party', 'Missing X-Canton-Party header (dev mode only)');
  }
  return party;
}

/**
 * Generate a Canton HS256 JWT for the given party (dev mode only).
 *
 * When the proxy is running in dev mode against a remote Canton participant
 * that uses HS256 JWT auth, this generates a valid token on the fly so the
 * dashboard doesn't need to know the JWT secret.
 *
 * Environment variables:
 *   CANTON_JWT_SECRET   — HMAC secret (REQUIRED, min 32 chars, no known-weak values)
 *   CANTON_JWT_AUDIENCE — JWT audience claim (default: "https://ledger_api.example.com")
 *
 * Throws if the secret is missing or weak.
 */
const KNOWN_WEAK_SECRETS = new Set([
  'unsafe', 'secret', 'changeme', 'default', 'password',
  'canton', 'admin', 'test', 'devsecret', 'localsecret',
]);

function getValidatedJwtSecret(): string {
  const secret = process.env['CANTON_JWT_SECRET'];
  if (!secret) {
    throw new Error(
      'CANTON_JWT_SECRET is required for dev-mode JWT generation. ' +
      'Generate one with: openssl rand -base64 32',
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `CANTON_JWT_SECRET must be at least 32 characters (got ${secret.length}). ` +
      'Generate one with: openssl rand -base64 32',
    );
  }
  if (KNOWN_WEAK_SECRETS.has(secret.toLowerCase())) {
    throw new Error(
      `CANTON_JWT_SECRET is set to a known-weak value. Replace with a strong random secret. ` +
      'Generate one with: openssl rand -base64 32',
    );
  }
  return secret;
}

function generateCantonJwt(party: string, actAs: string[]): string {
  const secret = getValidatedJwtSecret();
  const audience = process.env['CANTON_JWT_AUDIENCE'] ?? 'https://ledger_api.example.com';

  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({
    // Use the full party identifier for `sub` so participants that
    // enforce `sub == actAs prefix` accept the token. Stripping the namespace
    // also conflated parties with the same name across namespaces.
    sub: party,
    aud: audience,
    iat: now,
    exp: now + 3600,
    'https://daml.com/ledger-api': {
      ledgerId: 'participant1',
      applicationId: 'canton-streams',
      actAs,
      readAs: actAs,
    },
  });

  const sig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${sig}`;
}

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  const fromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (fromHeader) return fromHeader;
  // Dev-only fallback: `PROXY_DEFAULT_TOKEN` substituted for missing
  // Authorization made the default a master credential when paired with
  // attacker-controlled X-Canton-Party. Restrict to PROXY_AUTH_MODE=dev only.
  const mode = process.env['PROXY_AUTH_MODE'] ?? 'dev';
  if (mode === 'dev') {
    return process.env['PROXY_DEFAULT_TOKEN'] ?? undefined;
  }
  return undefined;
}

/** Truncate a party ID for safe inclusion in error messages. */
function truncateParty(party: string): string {
  if (party.length <= 40) return party;
  return party.slice(0, 20) + '...' + party.slice(-10);
}

// ---------------------------------------------------------------------------
// Startup safety gate
// ---------------------------------------------------------------------------

/**
 * Refuse to start in an unsafe auth posture. Call this once at
 * boot, before binding the listener.
 *
 * Two fail-closed checks:
 *  1. A `PROXY_AUTH_MODE=dev` request that did NOT also set
 *     `PROXY_ALLOW_DEV_AUTH=true` is a misconfiguration — the operator
 *     almost certainly did not intend to run a spoofable identity layer
 *     on a fund-moving service. Throw.
 *  2. Even when dev mode is explicitly acknowledged, refuse it unless
 *     the bind host is loopback (PROXY_BIND_HOST in {127.0.0.1, ::1,
 *     localhost} or unset, which Express binds to all interfaces — so we
 *     require it to be EXPLICITLY loopback). This stops an acknowledged
 *     dev posture from being exposed to a network.
 */
export function assertAuthConfigSafe(config: AuthConfig): void {
  if (config.requestedMode === 'dev' && !config.devAuthAcknowledged) {
    throw new Error(
      'Refusing to start: PROXY_AUTH_MODE=dev trusts the X-Canton-Party ' +
        'header and mints ledger JWTs for arbitrary parties. If this is ' +
        'genuinely a local-dev run, set PROXY_ALLOW_DEV_AUTH=true to ' +
        'acknowledge the risk. For any networked or production deployment, ' +
        'use PROXY_AUTH_MODE=jwt with PROXY_OIDC_ISSUER configured.',
    );
  }
  if (config.mode === 'dev') {
    const bindHost = process.env['PROXY_BIND_HOST'] ?? '';
    const loopback =
      bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
    if (!loopback) {
      throw new Error(
        'Refusing to start in dev auth mode without an explicit loopback ' +
          'bind. Set PROXY_BIND_HOST=127.0.0.1 to confine the spoofable ' +
          'dev identity layer to localhost, or switch to ' +
          'PROXY_AUTH_MODE=jwt.',
      );
    }
  }
  if (config.mode === 'jwt' && !config.jwtAudience && !config.audienceUnenforcedAcknowledged) {
    throw new Error(
      'Refusing to start: jwt mode without PROXY_JWT_AUDIENCE accepts any ' +
        'token the IdP minted, including one issued for a different relying ' +
        'party on the same IdP. Set PROXY_JWT_AUDIENCE to this proxy’s ' +
        'expected audience. For a local run where that is genuinely not ' +
        'applicable, set PROXY_ALLOW_ANY_AUDIENCE=true to acknowledge the risk.',
    );
  }
}

// ---------------------------------------------------------------------------
// Startup logging
// ---------------------------------------------------------------------------

export function logAuthConfig(config: AuthConfig): void {
  console.log(`  Auth mode: ${config.mode}`);

  if (config.mode === 'jwt') {
    console.log(`  OIDC issuer: ${config.oidcIssuer ?? '(none — using direct JWKS URL)'}`);
    console.log(`  JWT issuer: ${config.jwtIssuer ?? '(any)'}`);
    if (config.jwtAudience) {
      console.log(`  JWT audience: ${config.jwtAudience}`);
    } else {
      // Only reachable when PROXY_ALLOW_ANY_AUDIENCE=true explicitly waived
      // enforcement (assertAuthConfigSafe refuses to start otherwise).
      console.warn(
        '  ⚠ PROXY_JWT_AUDIENCE not set and PROXY_ALLOW_ANY_AUDIENCE=true — ' +
          'tokens are accepted regardless of their `aud` claim. Any token ' +
          'minted by this IdP for ANY relying party will be accepted. Do not ' +
          'use this outside local development.',
      );
    }
    if (config.jwtPartyClaim) {
      console.log(`  JWT party claim: ${config.jwtPartyClaim}`);
    }
  } else {
    console.warn('  ⚠ Auth mode is "dev" — trusting X-Canton-Party header. NEVER use in production.');
  }

  if (config.userParties) {
    console.log(`  User parties: ${[...config.userParties].map(truncateParty).join(', ')}`);
  } else {
    console.warn('  ⚠ PROXY_USER_PARTIES not set — any party can act. Set this in production.');
  }

  if (config.serviceToken) {
    console.log(`  Service token: configured`);
  } else {
    console.log(`  Service token: not configured (service/finalize routes disabled)`);
  }

  if (config.escrowOperator) {
    console.log(`  Escrow operator: ${truncateParty(config.escrowOperator)}`);
  }
}
