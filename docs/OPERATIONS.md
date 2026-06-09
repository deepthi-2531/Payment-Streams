# Operations and Maintenance Guide

Maintenance procedures, monitoring, troubleshooting, and handoff
documentation for Canton Payment Streams.

---

## Package Structure Overview

```
Canton-Streams/
  packages/
    daml/                     # On-ledger Daml templates
      interfaces/             #   Shared types (StreamConfig, VestingMode, etc.)
      main/                   #   Escrow templates, workflows, settlement adapters
      test/                   #   Daml script tests
      scripts/                #   Setup and demo scripts
    sdk/                      # TypeScript SDK (@canton-streams/sdk)
      src/
        client.ts             #   CantonStreamsClient entry point
        types/                #   Stream, config, balance types
        commands/              #   create, accept, withdraw, cancel, renew, query
        transport/             #   gRPC and JSON API transports
        accrual/               #   Balance calculator and ticker
    proxy/                    # Express REST proxy (port 4000)
    dashboard/                # React/Vite dashboard (port 3000)
    cli/                      # canton-streams CLI tool
    executor/                 # delegated execution service
  docs/                       # Project documentation
```

---

## Monitoring and Health Checks

### Proxy health endpoint

```bash
curl http://localhost:4000/api/health
# => { "status": "ok" }
```

A non-200 response or connection refusal indicates the proxy is down.
Integrate this into your uptime monitoring (e.g., Prometheus
blackbox_exporter, Datadog HTTP check).

### Canton participant health

```bash
# gRPC health check (requires grpcurl)
grpcurl -plaintext localhost:5001 grpc.health.v1.Health/Check

# Admin API status
curl http://localhost:5002/health
```

Check that:
- The participant is `SERVING` on gRPC port 5001
- The JSON API (if used) is reachable on port 7575
- DAR packages are uploaded and active

### Application-level checks

| Component   | Check                          | Frequency  |
|-------------|--------------------------------|------------|
| Proxy       | `GET /api/health`              | Every 30s  |
| Canton gRPC | gRPC health check on :5001     | Every 60s  |
| JSON API    | `GET /v2/version` on :7575     | Every 60s  |
| Dashboard   | HTTP 200 on :3000              | Every 60s  |

---

## Log Management

### Proxy logs

The proxy uses structured JSON logging (pino). Logs go to stdout.

```bash
# Follow proxy logs
docker logs -f canton-streams-proxy

# Filter for errors
docker logs canton-streams-proxy 2>&1 | jq 'select(.level >= 50)'
```

Key log fields:
- `level`: 30=info, 40=warn, 50=error
- `msg`: Human-readable message
- `err`: Error object (when present)
- `streamId`: Stream identifier (on stream operations)
- `party`: Acting party
- `latencyMs`: Request duration

### Dashboard console

Browser developer tools console. In production, the dashboard logs
errors to the console with structured context. Check for:
- Network errors (failed fetch to proxy or JSON API)
- WebSocket disconnections
- Rendering errors

### Canton participant logs

Canton participant logs are typically at:
```
/var/log/canton/participant.log   # system install
./canton/log/canton.log           # local sandbox
```

Key patterns to monitor:
- `WARN` or `ERROR` level entries
- `COMMAND_REJECTED` events (contention, authorization failures)
- `PACKAGE_UPLOAD` events (DAR deployments)
- `DOMAIN_CONNECTION` state changes

---

## Troubleshooting Guide

### Connection refused (proxy -> Canton)

**Symptom:** Proxy returns 500 with `ECONNREFUSED` or gRPC `UNAVAILABLE`.

**Causes and fixes:**
1. Canton participant is not running. Start it: `canton daemon start`
2. Wrong host/port in proxy config. Check `CANTON_HOST` and `CANTON_PORT` env vars.
3. TLS mismatch. Verify that `CANTON_USE_TLS` matches the participant config.

### Authentication failures (401 Unauthorized)

**Symptom:** API returns `{ "error": "...", "code": "UNAUTHORIZED" }`.

**Causes and fixes:**
1. Missing `Authorization` header. Ensure `Bearer <token>` is present.
2. Expired JWT. Re-issue the token from the auth provider.
3. Wrong JWKS endpoint. Check `AUTH_JWKS_URL` in proxy config.
4. Dev mode mismatch. If running in development, ensure `AUTH_MODE=dev`
   is set. In production, ensure JWKS is properly configured.

### DAR not found

**Symptom:** `PACKAGE_NOT_FOUND` or template not found errors from
the Ledger API.

**Causes and fixes:**
1. DAR not uploaded. Upload with:
   ```bash
   canton-streams dar upload --host localhost --port 5002
   ```
2. Wrong DAR version. Check the uploaded package ID matches what the
   SDK expects:
   ```bash
   grpcurl -plaintext localhost:5002 \
     com.digitalasset.canton.admin.participant.v30.PackageService/ListPackages
   ```
3. Template ID mismatch after DAR upgrade. Ensure the SDK version matches
   the deployed DAR version.

### DAR registered but not vetted

**Symptom:** stream create/accept reaches the ledger, but Canton returns
errors such as `INVALID_PRESCRIBED_SYNCHRONIZER_ID`,
`NO_SYNCHRONIZER_FOR_SUBMISSION`, or a participant-specific message saying
the streams package has not been vetted.

**Causes and fixes:**
1. The DAR was uploaded to the participant, but it was not vetted on the
   synchronizer used for submission. Request package vetting for the
   streams package ID on that participant/synchronizer pair.
   Do not rely on a successful DAR upload alone: `/v2/packages/<packageId>/status`
   must report a vetted state before hybrid-wallet create/accept/finalize flows
   are considered deployable.
2. The proxy is pointed at the right ledger API, but not the JSON API used
   for readiness checks. Set `CANTON_JSON_API_URL` and enable
   `PROXY_STARTUP_REQUIRE_VETTED_PACKAGES=1`.
3. Hybrid-wallet users require interactive submission. Enable
   `PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT=1` so the proxy
   fails fast if the participant does not expose that endpoint.
4. For native `CC` / `Amulet` streams, make sure the escrow operator also has
   wallet-gateway signer credentials configured. Package vetting only unblocks
   the ledger submission half; the payout leg still needs the hosted wallet
   signer to move the asset.
5. For hybrid/external escrow operators, also enable
   `PROXY_TOKEN_STANDARD_AUTOWITHDRAW_INTERACTIVE_ENABLED=1` and configure
   `PROXY_SERVICE_USER_ID` so the proxy can submit `Withdraw_TokenStandard`
   through interactive submission instead of plain gRPC submit-and-wait.
6. If recipient payouts must be claimed through the host app, set
   `PROXY_TOKEN_STANDARD_HOST_WALLET_ADAPTER` to match the app capability:
   `wallet-api-claim` for a direct claim endpoint or
   `wallet-gateway-transfer-accept` for an interactive accept/sign flow.

### Contract not active (409 Conflict)

**Symptom:** `CONTRACT_NOT_ACTIVE` or `{ "code": "CONFLICT" }` on
withdraw/cancel/renew operations.

**Causes and fixes:**
1. Concurrent operation. The contract was archived and recreated by
   another transaction. Retry the operation; the SDK transport layer
   retries automatically (up to 3 times with backoff).
2. Stream already completed or cancelled. Query the stream status before
   operating.
3. Stale contract ID. If using contract IDs directly (not going through
   the SDK query layer), re-query to get the current contract ID.

---

## DAR Upgrade Procedure

### Pre-upgrade checklist

- [ ] New DAR built and tested against Daml script tests
- [ ] SDK version compatible with new DAR (template IDs match)
- [ ] Backup participant state (see Backup section)
- [ ] Maintenance window communicated

### Upgrade steps

1. **Build the new DAR:**
   ```bash
   cd packages/daml/main
   daml build -o canton-streams-main.dar
   ```

2. **Upload to participant (non-destructive):**
   ```bash
   # Via Canton Admin API
   grpcurl -plaintext -d @ localhost:5002 \
     com.digitalasset.canton.admin.participant.v30.PackageService/UploadDarFile \
     < canton-streams-main.dar
   ```
   Old contracts remain valid. New contracts use the new package.

3. **Verify upload:**
   ```bash
   grpcurl -plaintext localhost:5002 \
     com.digitalasset.canton.admin.participant.v30.PackageService/ListPackages
   ```

4. **Update proxy and SDK** if template IDs changed:
   ```bash
   cd packages/sdk
   pnpm build
   cd ../proxy
   pnpm build
   # Restart the proxy
   ```

5. **Verify:** Create a test stream and exercise all operations.

### Rollback

Old package remains on the participant. Revert proxy/SDK to the previous
version. Existing contracts are unaffected; they reference their original
package ID.

---

## SDK Version Upgrade Procedure

1. **Update the SDK package:**
   ```bash
   pnpm update @canton-streams/sdk
   ```

2. **Check for breaking changes** in the SDK changelog. Common areas:
   - Type changes in `CreateStreamParams` or `Stream`
   - New required fields
   - Transport configuration changes

3. **Rebuild dependent packages:**
   ```bash
   pnpm -r build
   ```

4. **Run integration tests** against a sandbox:
   ```bash
   pnpm -r test
   ```

5. **Deploy** proxy and dashboard with the updated dependency.

---

## Backup and Recovery

### Canton participant snapshot

Canton supports participant state export for backup:

```bash
# Export participant state (varies by Canton version)
# Consult your Canton deployment documentation for the exact command.
# Typical approach:
canton health dump --output participant-backup-$(date +%Y%m%d).zip
```

### What to back up

| Data               | Location                            | Method              |
|--------------------|-------------------------------------|---------------------|
| Participant state  | Canton internal storage              | Canton health dump   |
| DAR packages       | Uploaded to participant              | Re-upload from repo  |
| Proxy config       | Environment variables / config file  | Version control      |
| JWT signing keys   | Auth provider                        | Auth provider backup |

### Recovery procedure

1. Restore the Canton participant from the backup snapshot.
2. Verify DAR packages are present (re-upload if missing).
3. Start the proxy and dashboard.
4. Verify connectivity with `GET /api/health`.
5. Query streams to confirm data integrity.

---

## Issue Triage

### P1 -- Critical (respond within 1 hour)

- Canton participant is unreachable
- Active streams cannot process withdrawals
- Data integrity issue (invariant violation on-ledger)
- Authentication system is down (all users locked out)

**Action:** Page on-call engineer. Investigate participant health
and proxy connectivity immediately.

### P2 -- High (respond within 4 hours)

- Proxy returning intermittent errors (>1% error rate)
- Batch creation failures
- Single settlement mode broken (others still working)
- Dashboard inaccessible but API still functional

**Action:** Investigate during business hours. Check logs for
recurring error patterns.

### P3 -- Low (respond within 1 business day)

- UI display inconsistency (balance ticker drift)
- Non-blocking warnings in logs
- Performance degradation below SLA but system still functional
- Documentation gaps or SDK type mismatches

**Action:** File an issue, prioritize in next sprint.

---

## Handoff Checklist for New Maintainers

### Access and credentials

- [ ] Canton participant admin access (Admin API port 5002)
- [ ] Auth provider admin access (for JWT/JWKS management)
- [ ] Source code repository access
- [ ] CI/CD pipeline access
- [ ] Monitoring dashboard access
- [ ] On-call rotation added

### Knowledge transfer

- [ ] Review `docs/ARCHITECTURE.md` for system overview
- [ ] Review `docs/API.md` for REST API reference
- [ ] Review `docs/QUICKSTART.md` for local development setup
- [ ] Walk through one end-to-end stream lifecycle in sandbox
- [ ] Review Daml templates in `packages/daml/main/daml/`
- [ ] Review `docs/THREAT-MODEL.md` for security model
- [ ] Understand the three settlement modes and when each is used
- [ ] Run Daml script tests: `cd packages/daml/test && daml test`
- [ ] Run SDK tests: `cd packages/sdk && pnpm test`

### Operational readiness

- [ ] Can deploy a DAR upgrade end-to-end
- [ ] Can diagnose a proxy connection failure
- [ ] Can read and interpret Canton participant logs
- [ ] Can issue/rotate JWT tokens for service accounts
- [ ] Knows the P1/P2/P3 escalation paths
- [ ] Has performed at least one backup/restore drill
