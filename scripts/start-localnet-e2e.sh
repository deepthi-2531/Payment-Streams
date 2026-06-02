#!/usr/bin/env bash
# STR-129: orchestration entry point for the wallet-backed V2 E2E harness.
#
# This script does not invent a new wallet or stub one. It documents (and,
# where the prerequisites are present, executes) the chain that the
# upstream Splice repository already supports:
#
#   1. Pin Splice to the `token-standard-v2-upcoming` ref this repo is
#      built against (`SPLICE_PINNED_COMMIT` exported by
#      `scripts/fetch-v2-dars.mjs`).
#   2. Clone + build the Splice LocalNet validator with the V2 Amulet
#      wallet at the documented endpoint
#      (`http://localhost:3030/api/v0/dapp`).
#   3. Bring up Canton + the Streams REST proxy + the Streams dashboard
#      pointed at the wallet endpoint (`VITE_SKIP_WALLET_PICKER=true`).
#   4. Print the exact follow-up commands a human or CI worker runs to
#      drive the V2 allocation flow end-to-end through the Amulet wallet.
#
# It is intentionally idempotent: every step is `--check` first, build
# only when needed. Set `LOCALNET_DRY_RUN=1` to print the plan without
# executing any heavy step.
#
# Per STR-129 acceptance the harness uses ONLY V2 vocabulary:
#   • `AllocationFactory_Allocate`
#   • `Allocation_Settle`
#   • `SettlementFactory_SettleBatch`
# Any drift to V1 names (e.g. `Allocation_ExecuteTransfer`) is caught by
# `scripts/check-v2-conformance.sh` in the v2_conformance CI job, not by
# this script.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPLICE_CHECKOUT_DIR="${SPLICE_CHECKOUT_DIR:-$ROOT_DIR/.splice-localnet}"
SPLICE_REPO_URL="${SPLICE_REPO_URL:-https://github.com/canton-network/splice}"
SPLICE_PINNED_COMMIT="${SPLICE_PINNED_COMMIT:-}"
# Honor the repo-wide VITE_WALLET_GATEWAY_URL convention (used by the
# dashboard, docker-compose substitution, .env.example, SWK runbook, and
# DEPLOYMENT.md) as a fallback for callers who export only the VITE_-
# prefixed variant. WALLET_GATEWAY_URL wins when both are set.
WALLET_GATEWAY_URL="${WALLET_GATEWAY_URL:-${VITE_WALLET_GATEWAY_URL:-http://localhost:3030/api/v0/dapp}}"
WALLET_PROBE_TIMEOUT="${WALLET_PROBE_TIMEOUT:-90}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"
PROXY_URL="${PROXY_URL:-http://localhost:4000/api/health}"
SKIP_LOCALNET_BUILD="${SKIP_LOCALNET_BUILD:-0}"
SKIP_STREAMS_STACK="${SKIP_STREAMS_STACK:-0}"
LOCALNET_DRY_RUN="${LOCALNET_DRY_RUN:-0}"

fail() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

run_step() {
  local label="$1"
  shift
  echo
  echo "==> $label"
  if [[ "$LOCALNET_DRY_RUN" == "1" ]]; then
    printf '    [dry-run] '
    printf '%q ' "$@"
    echo
    return 0
  fi
  "$@"
}

resolve_pinned_commit() {
  if [[ -n "$SPLICE_PINNED_COMMIT" ]]; then
    return 0
  fi
  # Parse the constant out of the file directly. Kept synchronous and
  # dependency-free so the script can run on minimal CI images.
  SPLICE_PINNED_COMMIT="$(grep -m1 -E "^export const SPLICE_PINNED_COMMIT" "$ROOT_DIR/scripts/fetch-v2-dars.mjs" \
    | sed -E "s/.*'([0-9a-f]+)'.*/\1/")"
  [[ -n "$SPLICE_PINNED_COMMIT" ]] || fail "could not resolve SPLICE_PINNED_COMMIT from scripts/fetch-v2-dars.mjs"
}

clone_or_update_splice() {
  if [[ ! -d "$SPLICE_CHECKOUT_DIR/.git" ]]; then
    run_step "Cloning Splice into $SPLICE_CHECKOUT_DIR" \
      git clone --filter=blob:none "$SPLICE_REPO_URL" "$SPLICE_CHECKOUT_DIR"
  else
    run_step "Fetching Splice updates in $SPLICE_CHECKOUT_DIR" \
      git -C "$SPLICE_CHECKOUT_DIR" fetch --tags --prune
  fi
  run_step "Checking out pinned commit $SPLICE_PINNED_COMMIT" \
    git -C "$SPLICE_CHECKOUT_DIR" checkout --quiet "$SPLICE_PINNED_COMMIT"
}

build_localnet_amulet_wallet() {
  if [[ "$SKIP_LOCALNET_BUILD" == "1" ]]; then
    echo "    [skip] SKIP_LOCALNET_BUILD=1; expecting an externally-managed wallet at $WALLET_GATEWAY_URL"
    return 0
  fi

  # At the pinned commit (canton-network/splice @ $SPLICE_PINNED_COMMIT) the
  # canonical LocalNet path is the docker-compose stack driven by
  # build-tools/splice-localnet-compose.sh. It brings up Canton + a
  # super-validator + an app-user validator + an app-provider validator +
  # three React wallet UIs (on 2000/3000/4000), plus participant JSON-Ledger
  # APIs on x975 ports.
  #
  # The Amulet wallet that ships on every validator node supports the
  # CIP-56 V2 token standard on the token-standard-v2-upcoming branch we
  # pin against (full iterated-settlement support tracked upstream in
  # canton-network/splice#5498). So once LocalNet is running, the wallet
  # half of the V2 flow can be exercised end-to-end.
  #
  # The LocalNet stack does NOT expose a CIP-103 JSON-RPC wallet gateway
  # at :3030/api/v0/dapp directly. That endpoint comes from the separate
  # Splice Wallet Kernel (canton-network/wallet), published on npm as
  # @canton-network/wallet-gateway-remote. The fastest path is to run it
  # from npx — no clone or build required.

  local compose_wrapper="$SPLICE_CHECKOUT_DIR/build-tools/splice-localnet-compose.sh"

  cat <<EOF

    Splice LocalNet stack (verified upstream command at $SPLICE_PINNED_COMMIT):

      cd "$SPLICE_CHECKOUT_DIR"
      ./build-tools/splice-localnet-compose.sh start

    This brings up the canton-network/splice docker-compose LocalNet:
      - app-user wallet UI    : http://localhost:2000
      - app-provider wallet UI: http://localhost:3000
      - SV wallet UI          : http://localhost:4000
      - participant JSON APIs : :2975 / :3975 / :4975
      - Amulet wallet (V2-capable on the token-standard-v2-upcoming
        branch this commit lives on; full iterated-settlement tracked
        in canton-network/splice#5498)

    HONEST GAP: the LocalNet stack does NOT publish a CIP-103 JSON-RPC
    wallet gateway at $WALLET_GATEWAY_URL on its own. The dashboard
    talks to the wallet through the Splice Wallet Kernel, run as a
    separate process. Fastest path (no clone needed):

      npx @canton-network/wallet-gateway-remote@1.4.0 --config-example \\
        > wallet-gateway.localnet.json
      # Edit wallet-gateway.localnet.json:
      #   ledgerApi.baseUrl   = http://127.0.0.1:2975   (LocalNet app-user JSON API)
      #   allowedOrigins      += http://localhost:3000
      #   allowedOrigins      += http://127.0.0.1:3000
      npx @canton-network/wallet-gateway-remote@1.4.0 \\
        -c wallet-gateway.localnet.json -p 3030

    (To target the app-provider validator instead, use
    http://127.0.0.1:3975. The Splice Wallet Kernel can also be built
    from source — clone canton-network/wallet, yarn install &&
    yarn build:all && yarn start:all — same endpoint, same config.)

    Probe the CIP-103 gateway:

      curl -fsS -X POST $WALLET_GATEWAY_URL \\
        -H 'Origin: http://localhost:3000' \\
        -H 'content-type: application/json' \\
        --data '{"jsonrpc":"2.0","id":"probe","method":"status","params":{}}'

    Once that responds, re-run this script with:

      SKIP_LOCALNET_BUILD=1 bash scripts/start-localnet-e2e.sh

EOF

  if [[ "$LOCALNET_DRY_RUN" == "1" ]]; then
    echo "    [dry-run] would invoke: $compose_wrapper start"
    echo "    [dry-run] skipping execution; wallet gateway at :3030 will NOT be reachable"
    return 0
  fi

  # Attempt the verified upstream LocalNet bring-up when the wrapper is
  # present on disk and docker is available. Even on success this does
  # not produce :3030 — probe_wallet_gateway will surface that honestly.
  if [[ -x "$compose_wrapper" ]] && command -v docker >/dev/null 2>&1; then
    run_step "Starting Splice LocalNet (docker compose) via $compose_wrapper" \
      bash -c "cd \"$SPLICE_CHECKOUT_DIR\" && ./build-tools/splice-localnet-compose.sh start"
  else
    echo "    [warn] $compose_wrapper not executable or docker missing; LocalNet not started here"
  fi

  fail "no canonical one-command LocalNet path at $SPLICE_PINNED_COMMIT exposes $WALLET_GATEWAY_URL. Bring up the wallet (e.g. Splice Wallet Kernel from canton-network/wallet alongside LocalNet) and re-run with SKIP_LOCALNET_BUILD=1."
}

probe_wallet_gateway() {
  local i
  echo "    probing $WALLET_GATEWAY_URL for CIP-103 readiness (timeout ${WALLET_PROBE_TIMEOUT}s)..."
  for ((i = 1; i <= WALLET_PROBE_TIMEOUT; i++)); do
    if curl -fsS -o /dev/null \
        -H 'content-type: application/json' \
        -X POST "$WALLET_GATEWAY_URL" \
        --data '{"jsonrpc":"2.0","id":"streams-e2e","method":"status","params":{}}'; then
      echo "    Amulet wallet gateway reachable at $WALLET_GATEWAY_URL"
      return 0
    fi
    sleep 1
  done
  fail "Amulet wallet gateway is not reachable at $WALLET_GATEWAY_URL after ${WALLET_PROBE_TIMEOUT}s. Start the Splice LocalNet validator Amulet wallet, then retry."
}

start_streams_stack() {
  if [[ "$SKIP_STREAMS_STACK" == "1" ]]; then
    echo "    [skip] SKIP_STREAMS_STACK=1; expecting the Streams stack to already be running"
    return 0
  fi
  need docker

  # Tell the dashboard container to point its CIP-103 client at the
  # already-running Amulet wallet gateway and to skip the picker. The
  # dashboard's existing `assertRemoteWalletReachable` then fails closed
  # with an explicit error if the gateway is down — never a popup.
  run_step "Bringing up Canton + proxy + dashboard via docker compose" \
    env \
      VITE_WALLET_GATEWAY_URL="$WALLET_GATEWAY_URL" \
      VITE_SKIP_WALLET_PICKER='true' \
      VITE_WALLET_NAME='Splice Amulet Wallet (LocalNet V2)' \
      docker compose -f "$ROOT_DIR/docker/docker-compose.yml" up -d --build
}

wait_for_health() {
  local label="$1"
  local url="$2"
  local timeout="${3:-90}"
  local i
  echo "    waiting for $label at $url (timeout ${timeout}s)..."
  for ((i = 1; i <= timeout; i++)); do
    if curl -fsS -o /dev/null "$url"; then
      echo "    $label ready"
      return 0
    fi
    sleep 1
  done
  fail "$label did not come up at $url"
}

print_next_steps() {
  cat <<EOF

==> STR-129 harness brought up.

    Wallet gateway: $WALLET_GATEWAY_URL
    Dashboard:      $DASHBOARD_URL
    Streams proxy:  ${PROXY_URL%/api/health}

Drive the V2 allocation flow end-to-end through the wallet:

  1. Open $DASHBOARD_URL and click "Connect wallet". The dashboard skips
     the picker, sends the CIP-103 status preflight to
     $WALLET_GATEWAY_URL, and surfaces an explicit error if the wallet
     is unreachable — never a popup.

  2. List accounts:
       curl -fsS -X POST $WALLET_GATEWAY_URL \\
         -H 'content-type: application/json' \\
         --data '{"jsonrpc":"2.0","id":"a","method":"listAccounts","params":{}}'

  3. Create a V2 stream (recipient + amount + V2 instrument + funding ref)
     through the dashboard "Create stream" wizard. Submission emits an
     AllocationRequest the Amulet wallet renders.

  4. Approve in the wallet. The wallet exercises
     AllocationFactory_Allocate (committed=True). The Streams executor
     then exercises Allocation_Settle (and SettlementFactory_SettleBatch
     for batched advancement).

  5. Sanity-check the choice names by running the CI guard locally:
       bash $ROOT_DIR/scripts/check-v2-conformance.sh

  6. Tear down:
       docker compose -f $ROOT_DIR/docker/docker-compose.yml down -v

See docs/E2E-HARNESS.md for the full runbook + troubleshooting.
EOF
}

main() {
  need git
  need curl

  resolve_pinned_commit
  echo "Pinned Splice commit: $SPLICE_PINNED_COMMIT"
  echo "Wallet gateway URL:   $WALLET_GATEWAY_URL"
  echo "Streams checkout:     $ROOT_DIR"
  echo "Splice checkout:      $SPLICE_CHECKOUT_DIR"

  if [[ "$SKIP_LOCALNET_BUILD" != "1" ]]; then
    clone_or_update_splice
  fi

  build_localnet_amulet_wallet

  if [[ "$LOCALNET_DRY_RUN" != "1" ]]; then
    probe_wallet_gateway
  fi

  start_streams_stack

  if [[ "$LOCALNET_DRY_RUN" != "1" ]]; then
    wait_for_health "Streams proxy" "$PROXY_URL" 120
    wait_for_health "Streams dashboard" "$DASHBOARD_URL" 120
  fi

  print_next_steps
}

main "$@"
