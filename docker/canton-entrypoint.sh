#!/usr/bin/env bash
set -euo pipefail

ledger_port="${CANTON_LEDGER_API_PORT:-6865}"
admin_port="${CANTON_ADMIN_API_PORT:-10011}"
json_port="${CANTON_JSON_API_PORT:-}"

args=(
  sandbox
  -C
  canton.participants.sandbox.ledger-api.address=0.0.0.0,canton.participants.sandbox.admin-api.address=0.0.0.0
  --ledger-api-port "$ledger_port"
  --admin-api-port "$admin_port"
)

if [[ -n "$json_port" ]]; then
  args+=(--json-api-port "$json_port")
fi

shopt -s nullglob
for dar in /canton/dars/*.dar; do
  args+=(--dar "$dar")
done
shopt -u nullglob

exec dpm "${args[@]}"
