# REST API Reference

Base URL: `http://localhost:4000` (default proxy port; configurable via `PROXY_PORT`).

## Authentication

All endpoints except `/api/health` require a JWT bearer token:

```
Authorization: Bearer <jwt>
```

The proxy reads the caller's identity from the JWT's `party` claim (or `sub` if `party` is absent). The proxy does **not** require a separate `X-Canton-Party` header for browser callers; the legacy header is still accepted for backwards compatibility with older scripts.

In `PROXY_AUTH_MODE=jwt` (production), the proxy validates the JWT signature against the configured JWKS endpoint. In `PROXY_AUTH_MODE=dev` (local), signature verification is bypassed but the JWT must still parse and contain a `party`/`sub` claim.

## Health

### `GET /api/health`

Returns proxy health + readiness state. No auth required.

**Response — `200 OK`:**

```json
{
  "status": "ok",
  "canton": { "host": "localhost", "port": 5001 },
  "readiness": {
    "status": "ok",
    "checkedAt": "2026-05-23T12:00:00.000Z",
    "jsonApiUrl": "http://localhost:7575",
    "checks": {
      "packageEndpoint": {
        "status": "ok",
        "message": "Required packages are visible on the JSON API participant."
      },
      "vettedPackages": {
        "status": "ok",
        "message": "Required packages are vetted for submission."
      },
      "interactiveSubmission": {
        "status": "ok",
        "message": "Interactive submission endpoint is reachable."
      }
    }
  }
}
```

`"status": "degraded"` means the proxy is reachable but startup validation failed (e.g. the canton-streams DAR is uploaded but not vetted on the synchronizer, or the interactive-submission endpoint is unreachable). See [DEPLOYMENT.md](DEPLOYMENT.md) for readiness flag configuration.

## Streams

### `POST /api/streams`

Create a new payment stream. The caller becomes the stream's sender.

**Request body:**

```json
{
  "streamId": "payment-001",
  "recipient": "Bob::1220...",
  "totalDeposited": "1000.0",
  "vestingMode": { "mode": "Linear" },
  "startTime": "2026-06-01T00:00:00Z",
  "endTime": "2026-07-01T00:00:00Z",
  "cancellable": true,
  "settlementMode": "TokenStandardCustody",
  "asset": {
    "instrumentId": "MyAsset",
    "admin": "MyAssetAdmin::1220..."
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `streamId` | string | yes | Unique stream identifier (within the sender) |
| `recipient` | string | yes | Recipient party id |
| `totalDeposited` | string | yes | Total amount to escrow (decimal, 10 places) |
| `vestingMode` | object | yes | See vesting modes below |
| `startTime` | string | yes | ISO 8601 |
| `endTime` | string | yes | ISO 8601 |
| `cancellable` | boolean | yes | Whether sender can unilaterally cancel |
| `settlementMode` | string | yes | Must be `TokenStandardCustody`; the asset registry selects the V2 lane when available or the transitional V1 lane for registered V1 assets |
| `asset` | object | yes | `{ instrumentId, admin }` — must match a registered asset in `config/asset-registry.json` |

**Vesting modes:**

```jsonc
{ "mode": "Linear" }
{ "mode": "CliffLinear", "cliffTime": "2026-06-15T00:00:00Z" }
{ "mode": "Stepped", "stepInterval": 86400000000, "amountPerStep": "100.0" }   // microseconds
{ "mode": "RenewableTerm", "termDuration": 2592000000000, "maxRenewals": 12 }  // microseconds, 30d
```

**Response — `201 Created`:**

```json
{
  "requestContractId": "00a1b2c3...",
  "streamId": "payment-001",
  "summary": {
    "settlementMode": "TokenStandardCustody",
    "asset": "MyAsset",
    "totalDeposited": "1000.0",
    "vestingMode": "Linear"
  }
}
```

### `GET /api/streams`

List streams visible to the caller (as sender, recipient, or operator).

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `status` | string | `Pending` / `Active` / `Completed` / `Cancelled` |
| `sender` | string | Filter by sender party id |
| `recipient` | string | Filter by recipient party id |
| `vestingMode` | string | `Linear` / `CliffLinear` / `Stepped` / `RenewableTerm` |

**Response — `200 OK`:**

```json
[
  {
    "contractId": "00a1b2c3...",
    "config": {
      "streamId": "payment-001",
      "sender": "Alice::1220...",
      "recipient": "Bob::1220...",
      "totalDeposited": "1000.0",
      "startTime": "2026-06-01T00:00:00.000Z",
      "endTime": "2026-07-01T00:00:00.000Z",
      "vestingMode": { "mode": "Linear" },
      "cancellable": true,
      "settlementMode": "TokenStandardCustody",
      "asset": {
        "instrumentId": "MyAsset",
        "admin": "MyAssetAdmin::1220..."
      }
    },
    "state": {
      "status": "Active",
      "totalWithdrawn": "50.0",
      "lastWithdrawTime": "2026-06-15T12:00:00.000Z",
      "renewalCount": 0
    },
    "balances": {
      "accrued": "200.0",
      "available": "150.0",
      "escrowed": "950.0"
    }
  }
]
```

### `GET /api/streams/:sender/:streamId`

Get a single stream by composite id `(sender, streamId)`.

**Response — `200 OK`:** same shape as a single element of the list response.

### `GET /api/streams/:sender/:streamId/history`

Get the on-ledger event history for the stream.

**Response — `200 OK`:**

```json
[
  {
    "kind": "Created",
    "at": "2026-06-01T00:00:00.000Z",
    "offset": "000000000000123",
    "source": "ledger"
  },
  {
    "kind": "Accepted",
    "at": "2026-06-01T00:00:05.000Z",
    "by": "Bob::1220...",
    "source": "ledger"
  },
  {
    "kind": "Withdrawn",
    "at": "2026-06-15T12:00:00.000Z",
    "amount": "50.0",
    "source": "ledger"
  }
]
```

`source` is `"ledger"` for confirmed on-chain events; the proxy never inserts synthetic estimates.

### `POST /api/streams/:sender/:streamId/accept`

Accept a pending stream request. Caller must be the recipient.

**Response — `200 OK`:**

```json
{ "acceptedContractId": "00a1b2c3..." }
```

### `POST /api/streams/:sender/:streamId/withdraw`

Withdraw all currently-accrued funds. Caller must be the recipient.

**Response — `200 OK`:**

```json
{
  "amountWithdrawn": "50.0",
  "newTotalWithdrawn": "100.0",
  "newStatus": "Active"
}
```

### `POST /api/streams/:sender/:streamId/cancel`

Sender-initiated cancel. Only valid when `cancellable: true`.

**Response — `200 OK`:**

```json
{
  "refundedToSender": "850.0",
  "settledToRecipient": "150.0",
  "newStatus": "Cancelled"
}
```

### `POST /api/streams/:sender/:streamId/mutual-cancel`

Mutual cancel. Requires both sender and recipient to have submitted matching requests.

### `POST /api/streams/:sender/:streamId/renew`

Renew a `RenewableTerm` stream for the next period.

## Pending requests (inbox)

### `GET /api/stream-requests`

List pending stream requests visible to the caller.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `sender` | string | Filter by sender party id (scoped to the caller) |
| `recipient` | string | Filter by recipient party id (scoped to the caller) |
| `assetType` | string | Filter by asset type |

**Response — `200 OK`:** array of pending-request objects with the request id, proposer party, target party, and proposed `config`.

The `POST /api/streams/:sender/:streamId/accept` and `/reject` routes are reserved for the future V2 `StreamAdminRequest` template and return `404` (`request_not_found`) by design today: the dashboard creates a `StreamAdmin` directly, so there is no intermediate request contract to accept or reject at this layer.

## Policies

### `GET /api/policies`

List `DelegatedPolicy` contracts visible to the caller (typically as sender, recipient, or executor).

### `POST /api/policies/:contractId/revoke`

Revoke a `DelegatedPolicy`. Caller must be the policy sender.

### `GET /api/execution-logs`

List the append-only `ExecutionLog` audit entries visible to the caller.

## Adoption metrics

Aggregated adoption metrics are computed offline (not exposed as a REST route) via `scripts/query-adoption-metrics.mjs --asset-registry config/asset-registry.json --since <date>`, which reads the per-asset Scan endpoints configured in `config/asset-registry.json`.

## Errors

All error responses use the same shape:

```json
{
  "error": "Human-readable summary",
  "reason": "machine_readable_code",
  "correlationId": "<operation>-<id>"  // present on all 5xx responses, for log correlation
}
```

Common reason codes:

| Code | HTTP | Meaning |
|---|---|---|
| `missing_token` | 401 | No `Authorization: Bearer <token>` header |
| `token_expired` | 401 | JWT has expired |
| `invalid_signature` | 401 | JWT signature verification failed (jwt mode) |
| `invalid_token` | 401 | JWT could not be verified |
| `missing_party` | 400 | JWT did not carry a `party`/`sub` claim |
| `forbidden` | 403 | Caller not authorized for this action on this stream |
| `not_found` / `stream_not_found` / `request_not_found` | 404 | Stream / request not found |
| `self_stream` | 400 | Stream sender and recipient are the same party |
| `settlement_mismatch` | 422 | Settled amount did not match the expected accrual |
| `deposit_undelivered` | 422 | Escrow deposit holding was not delivered on-ledger |
| `escrow_cap_exceeded` | 409 | Deposit would exceed the aggregate custody cap (`ESCROW_MAX_TOTAL_CC`) |
| `escrow_pool_insolvent` | 409 | Pre-release solvency interlock tripped (custody pool below owed) |
| `undisclosed_custody` | 403 | Co-hosted operator-custodial money leg blocked unless `ESCROW_DISCLOSED_CUSTODY` is set |
| `undisclosed_custody_probe_failed` | 502 | Could not probe whether the payer is co-hosted on the operator participant (fail-closed) |
| `store_lock_timeout` | 503 | Single-writer store lock could not be acquired |
| `request_error` | 4xx | Malformed or otherwise rejected client request |
| `internal_error` | 5xx | Unexpected server error (see `correlationId` in logs) |

## Versioning

This is the `v1` REST surface. Breaking changes are flagged in [CHANGELOG.md](../CHANGELOG.md) under the relevant release.
