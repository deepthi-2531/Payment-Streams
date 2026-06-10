#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT_DIR/packages/sdk"
SMOKE_HELPER="$ROOT_DIR/scripts/devnet-smoke.mjs"

LEDGER_HOST="${LEDGER_HOST:-127.0.0.1}"
LEDGER_PORT="${LEDGER_PORT:-5001}"
LEDGER_TLS="${LEDGER_TLS:-false}"
CANTON_SYNCHRONIZER_ID="${CANTON_SYNCHRONIZER_ID:-}"

# Set these for your own environment. Defaults are placeholders, not real
# infrastructure — the tunnel path (START_TUNNEL=1) requires real values.
VALIDATOR_SSH_HOST="${VALIDATOR_SSH_HOST:-user@bastion.example.invalid}"
VALIDATOR_TUNNEL_TARGET_HOST="${VALIDATOR_TUNNEL_TARGET_HOST:-validator.internal.invalid}"
VALIDATOR_TUNNEL_GRPC_PORT="${VALIDATOR_TUNNEL_GRPC_PORT:-5001}"
VALIDATOR_TUNNEL_JSON_PORT="${VALIDATOR_TUNNEL_JSON_PORT:-7575}"
START_TUNNEL="${START_TUNNEL:-0}"

SETTLEMENT_MODE="${SETTLEMENT_MODE:-UtilityHoldingCustody}"
ASSET_TYPE="${ASSET_TYPE:-}"
STREAM_AMOUNT="${STREAM_AMOUNT:-1000}"
VESTING_MODE="${VESTING_MODE:-linear}"
CANCELLABLE="${CANCELLABLE:-true}"
RUN_WITHDRAW="${RUN_WITHDRAW:-0}"
RUN_CANCEL="${RUN_CANCEL:-0}"
RUN_LIST_BEFORE="${RUN_LIST_BEFORE:-1}"
RUN_LIST_AFTER="${RUN_LIST_AFTER:-1}"

START_TIME="${START_TIME:-$(date -u -v+5M '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)}"
END_TIME="${END_TIME:-$(date -u -v+30d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)}"

cleanup() {
  if [[ -n "${TUNNEL_PID:-}" ]]; then
    kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

join_csv_unique() {
  local out=""
  local item
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    if [[ ",$out," != *",$item,"* ]]; then
      out="${out:+$out,}$item"
    fi
  done
  printf '%s' "$out"
}

resolve_defaults() {
  if [[ -z "${ASSET_TYPE:-}" ]]; then
    if [[ "$SETTLEMENT_MODE" == "LocalAssetCustody" ]]; then
      ASSET_TYPE="validator-local-asset"
    else
      ASSET_TYPE="global-cip56"
    fi
  fi

  FINALIZE_TOKEN="${FINALIZE_TOKEN:-${SERVICE_TOKEN:-${ESCROW_OPERATOR_TOKEN:-}}}"
  WITHDRAW_TOKEN="${WITHDRAW_TOKEN:-${SERVICE_TOKEN:-${FINALIZE_TOKEN:-}}}"
  CANCEL_TOKEN="${CANCEL_TOKEN:-${SERVICE_TOKEN:-${FINALIZE_TOKEN:-}}}"
  LIST_TOKEN="${LIST_TOKEN:-${SENDER_TOKEN:-}}"
  INSPECT_TOKEN="${INSPECT_TOKEN:-${RECIPIENT_TOKEN:-}}"

  FINALIZE_USER_ID="${FINALIZE_USER_ID:-${SERVICE_USER_ID:-}}"
  WITHDRAW_USER_ID="${WITHDRAW_USER_ID:-${SERVICE_USER_ID:-${FINALIZE_USER_ID:-}}}"
  CANCEL_USER_ID="${CANCEL_USER_ID:-${SERVICE_USER_ID:-${FINALIZE_USER_ID:-}}}"
  LIST_USER_ID="${LIST_USER_ID:-${SENDER_USER_ID:-}}"
  INSPECT_USER_ID="${INSPECT_USER_ID:-${RECIPIENT_USER_ID:-}}"

  CREATE_ACT_AS="${CREATE_ACT_AS:-${SENDER_PARTY:-}}"
  ACCEPT_ACT_AS="${ACCEPT_ACT_AS:-${RECIPIENT_PARTY:-}}"
  LIST_ACT_AS="${LIST_ACT_AS:-${SENDER_PARTY:-}}"
  INSPECT_ACT_AS="${INSPECT_ACT_AS:-${RECIPIENT_PARTY:-}}"

  if [[ "$SETTLEMENT_MODE" == "LocalAssetCustody" ]]; then
    FINALIZE_ACT_AS="${FINALIZE_ACT_AS:-$(join_csv_unique "${SENDER_PARTY:-}" "${RECIPIENT_PARTY:-}" "${ESCROW_OPERATOR_PARTY:-}")}"
    WITHDRAW_ACT_AS="${WITHDRAW_ACT_AS:-$(join_csv_unique "${RECIPIENT_PARTY:-}" "${ESCROW_OPERATOR_PARTY:-}")}"
    CANCEL_ACT_AS="${CANCEL_ACT_AS:-$(join_csv_unique "${SENDER_PARTY:-}" "${RECIPIENT_PARTY:-}" "${ESCROW_OPERATOR_PARTY:-}")}"
  else
    FINALIZE_ACT_AS="${FINALIZE_ACT_AS:-$(join_csv_unique "${SENDER_PARTY:-}" "${RECIPIENT_PARTY:-}" "${ESCROW_OPERATOR_PARTY:-}" "${INSTRUMENT_ISSUER:-}" "${INSTRUMENT_DEPOSITORY:-}")}"
    WITHDRAW_ACT_AS="${WITHDRAW_ACT_AS:-$(join_csv_unique "${RECIPIENT_PARTY:-}" "${ESCROW_OPERATOR_PARTY:-}" "${INSTRUMENT_ISSUER:-}" "${INSTRUMENT_DEPOSITORY:-}")}"
    CANCEL_ACT_AS="${CANCEL_ACT_AS:-$(join_csv_unique "${SENDER_PARTY:-}" "${RECIPIENT_PARTY:-}" "${ESCROW_OPERATOR_PARTY:-}" "${INSTRUMENT_ISSUER:-}" "${INSTRUMENT_DEPOSITORY:-}")}"
  fi
}

check_env() {
  local required=(
    SENDER_PARTY
    RECIPIENT_PARTY
    SENDER_TOKEN
    RECIPIENT_TOKEN
    HOLDING_CID
    ESCROW_OPERATOR_PARTY
    FINALIZE_TOKEN
  )

  if [[ "$SETTLEMENT_MODE" == "LocalAssetCustody" ]]; then
    required+=(RECIPIENT_ACCOUNT_JSON)
  else
    required+=(
      INSTRUMENT_ID
      INSTRUMENT_VERSION
      INSTRUMENT_ISSUER
      INSTRUMENT_DEPOSITORY
    )
  fi

  if [[ "$RUN_WITHDRAW" == "1" ]]; then
    required+=(WITHDRAW_TOKEN)
  fi

  if [[ "$RUN_CANCEL" == "1" ]]; then
    required+=(CANCEL_TOKEN)
  fi

  local name
  for name in "${required[@]}"; do
    [[ -n "${!name:-}" ]] || fail "missing env var: $name"
  done
}

ensure_build() {
  if [[ ! -f "$SDK_DIR/dist/index.js" ]]; then
    echo "Building SDK..."
    (cd "$SDK_DIR" && npm run build)
  fi
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local retries="${3:-20}"
  local i
  for ((i = 1; i <= retries; i++)); do
    if bash -lc "exec 3<>/dev/tcp/$host/$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_tunnel() {
  if wait_for_port "$LEDGER_HOST" "$LEDGER_PORT" 1; then
    echo "Ledger already reachable on $LEDGER_HOST:$LEDGER_PORT"
    return 0
  fi

  [[ "$START_TUNNEL" == "1" ]] || fail "ledger port $LEDGER_HOST:$LEDGER_PORT is not reachable; start the SSH tunnel or set START_TUNNEL=1"

  echo "Starting validator tunnel to $VALIDATOR_SSH_HOST..."
  ssh -N \
    -L "$LEDGER_PORT:$VALIDATOR_TUNNEL_TARGET_HOST:$VALIDATOR_TUNNEL_GRPC_PORT" \
    -L "${VALIDATOR_TUNNEL_JSON_PORT}:$VALIDATOR_TUNNEL_TARGET_HOST:$VALIDATOR_TUNNEL_JSON_PORT" \
    "$VALIDATOR_SSH_HOST" &
  TUNNEL_PID=$!

  wait_for_port "$LEDGER_HOST" "$LEDGER_PORT" 20 || fail "validator tunnel did not come up on $LEDGER_HOST:$LEDGER_PORT"
  echo "Tunnel ready on $LEDGER_HOST:$LEDGER_PORT"
}

run_sdk_action() {
  local action="$1"
  local token="$2"
  local user_id="$3"
  local act_as="$4"
  local read_as="${5:-}"

  env \
    CANTON_SMOKE_HOST="$LEDGER_HOST" \
    CANTON_SMOKE_PORT="$LEDGER_PORT" \
    CANTON_SMOKE_TLS="$LEDGER_TLS" \
    CANTON_SMOKE_SYNCHRONIZER_ID="$CANTON_SYNCHRONIZER_ID" \
    CANTON_SMOKE_TOKEN="$token" \
    CANTON_SMOKE_USER_ID="$user_id" \
    CANTON_SMOKE_ACT_AS="$act_as" \
    CANTON_SMOKE_READ_AS="$read_as" \
    SETTLEMENT_MODE="$SETTLEMENT_MODE" \
    ASSET_TYPE="$ASSET_TYPE" \
    STREAM_AMOUNT="$STREAM_AMOUNT" \
    VESTING_MODE="$VESTING_MODE" \
    CANCELLABLE="$CANCELLABLE" \
    START_TIME="$START_TIME" \
    END_TIME="$END_TIME" \
    STREAM_ID="${STREAM_ID:-}" \
    ACCEPTED_REQUEST_CONTRACT_ID="${ACCEPTED_REQUEST_CONTRACT_ID:-}" \
    SENDER_PARTY="$SENDER_PARTY" \
    RECIPIENT_PARTY="$RECIPIENT_PARTY" \
    HOLDING_CID="$HOLDING_CID" \
    ESCROW_OPERATOR_PARTY="$ESCROW_OPERATOR_PARTY" \
    INSTRUMENT_ID="${INSTRUMENT_ID:-}" \
    INSTRUMENT_VERSION="${INSTRUMENT_VERSION:-}" \
    INSTRUMENT_ISSUER="${INSTRUMENT_ISSUER:-}" \
    INSTRUMENT_DEPOSITORY="${INSTRUMENT_DEPOSITORY:-}" \
    SENDER_ACCOUNT_JSON="${SENDER_ACCOUNT_JSON:-}" \
    RECIPIENT_ACCOUNT_JSON="${RECIPIENT_ACCOUNT_JSON:-}" \
    CLIFF_TIME="${CLIFF_TIME:-}" \
    STEP_INTERVAL="${STEP_INTERVAL:-}" \
    AMOUNT_PER_STEP="${AMOUNT_PER_STEP:-}" \
    TERM_DURATION="${TERM_DURATION:-}" \
    node "$SMOKE_HELPER" "$action"
}

print_config() {
  cat <<EOF
Smoke test configuration
  ledger:           $LEDGER_HOST:$LEDGER_PORT
  settlement mode:  $SETTLEMENT_MODE
  asset type:       $ASSET_TYPE
  sender:           $SENDER_PARTY
  recipient:        $RECIPIENT_PARTY
  escrow operator:  $ESCROW_OPERATOR_PARTY
  amount:           $STREAM_AMOUNT
  vesting:          $VESTING_MODE
  start:            $START_TIME
  end:              $END_TIME
  finalize actAs:   $FINALIZE_ACT_AS
  withdraw actAs:   $WITHDRAW_ACT_AS
  cancel actAs:     $CANCEL_ACT_AS
  withdraw:         $RUN_WITHDRAW
  cancel:           $RUN_CANCEL
EOF
}

create_stream_request() {
  local output
  output="$(run_sdk_action create "$SENDER_TOKEN" "${SENDER_USER_ID:-}" "$CREATE_ACT_AS")"

  echo "$output"

  REQUEST_CONTRACT_ID="$(echo "$output" | awk -F': ' '/^Contract ID:/ {print $2}' | tail -n1 | xargs)"
  STREAM_ID="$(echo "$output" | awk -F': ' '/^Stream ID:/ {print $2}' | tail -n1 | xargs)"

  [[ -n "${REQUEST_CONTRACT_ID:-}" ]] || fail "could not parse request contract id from create output"
  [[ -n "${STREAM_ID:-}" ]] || fail "could not parse stream id from create output"
}

accept_stream_request() {
  local output
  echo "Accepting stream request as recipient..."
  output="$(run_sdk_action accept "$RECIPIENT_TOKEN" "${RECIPIENT_USER_ID:-}" "$ACCEPT_ACT_AS")"
  echo "$output"

  ACCEPTED_REQUEST_CONTRACT_ID="$(echo "$output" | awk -F': ' '/^Accept Result Contract ID:/ {print $2}' | tail -n1 | xargs)"
  [[ -n "${ACCEPTED_REQUEST_CONTRACT_ID:-}" ]] || fail "could not parse accepted request contract id from accept output"
}

finalize_stream_request() {
  local output
  echo "Finalizing custody as escrow operator/service..."
  output="$(run_sdk_action finalize "$FINALIZE_TOKEN" "$FINALIZE_USER_ID" "$FINALIZE_ACT_AS")"
  echo "$output"

  ACTIVE_STREAM_CONTRACT_ID="$(echo "$output" | awk -F': ' '/^Active Stream Contract ID:/ {print $2}' | tail -n1 | xargs)"
  [[ -n "${ACTIVE_STREAM_CONTRACT_ID:-}" ]] || fail "could not parse active stream contract id from finalize output"
}

inspect_stream() {
  echo "Inspecting active stream..."
  run_sdk_action inspect "$INSPECT_TOKEN" "$INSPECT_USER_ID" "$INSPECT_ACT_AS"
}

withdraw_stream() {
  echo "Withdrawing as recipient..."
  run_sdk_action withdraw "$WITHDRAW_TOKEN" "$WITHDRAW_USER_ID" "$WITHDRAW_ACT_AS"
}

cancel_stream() {
  echo "Cancelling as sender..."
  run_sdk_action cancel "$CANCEL_TOKEN" "$CANCEL_USER_ID" "$CANCEL_ACT_AS"
}

list_streams() {
  local label="$1"
  echo "Listing streams ($label)..."
  run_sdk_action list "$LIST_TOKEN" "$LIST_USER_ID" "$LIST_ACT_AS" || true
}

main() {
  need node
  need npm
  need ssh
  need awk

  resolve_defaults
  check_env
  ensure_build
  ensure_tunnel
  print_config

  if [[ "$RUN_LIST_BEFORE" == "1" ]]; then
    list_streams before
  fi

  create_stream_request
  echo "Created request contract:  $REQUEST_CONTRACT_ID"
  echo "Created stream id:         $STREAM_ID"

  accept_stream_request
  echo "Accepted request contract: $ACCEPTED_REQUEST_CONTRACT_ID"

  finalize_stream_request
  echo "Active stream contract:    $ACTIVE_STREAM_CONTRACT_ID"

  inspect_stream

  if [[ "$RUN_WITHDRAW" == "1" ]]; then
    withdraw_stream
    inspect_stream
  fi

  if [[ "$RUN_CANCEL" == "1" ]]; then
    cancel_stream
    inspect_stream || true
  fi

  if [[ "$RUN_LIST_AFTER" == "1" ]]; then
    list_streams after
  fi

  echo "Smoke test complete."
}

main "$@"
