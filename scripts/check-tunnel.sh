#!/usr/bin/env bash
#
# Tunnel health check — detect when a local Canton sandbox is shadowing
# an SSH tunnel that's supposed to forward to a remote validator.
#
# This script exists because a stale local Canton sandbox bound to
# 127.0.0.1:5001 can silently shadow an SSH tunnel that died. When that
# happens, the local proxy + daml-script route to the LOCAL sandbox
# instead of the intended remote without any error — leading to confused
# contracts created in the wrong place.
#
# Run before any session that expects the tunnel to point at a remote
# validator.
#
# Usage:
#   scripts/check-tunnel.sh                # check, exit 0 if clean
#   scripts/check-tunnel.sh --fix          # also kill any local-sandbox holders
#
# Configuration (env vars — set in your shell or .env.local):
#   TUNNEL_LEDGER_PORT      Local port the SSH tunnel forwards for the
#                           Canton ledger API. Default: 5001.
#   TUNNEL_JSON_API_PORT    Local port for the JSON API. Default: 7575.
#   TUNNEL_EXPECTED_REMOTE  IP/hostname of the remote validator. Required.
#   TUNNEL_BASTION          SSH user@host for the bastion (jump host).
#                           Required if you want the script to print the
#                           reopen command. Example: "ubuntu@bastion.example.com"
#   TUNNEL_SSH_KEY          Path to the SSH key. Default: "${HOME}/.ssh/id_ed25519"
#
# Exit codes:
#   0  Tunnel is the only listener on the expected ports
#   1  No listener on the ledger port (no tunnel)
#   2  Listener on the ledger port but it's NOT an ssh tunnel (shadowing!)
#

set -u

PORT_LEDGER="${TUNNEL_LEDGER_PORT:-5001}"
PORT_JSON_API="${TUNNEL_JSON_API_PORT:-7575}"
TUNNEL_EXPECTED_REMOTE="${TUNNEL_EXPECTED_REMOTE:-<remote-validator-host>}"
BASTION="${TUNNEL_BASTION:-<bastion-user>@<bastion-host>}"
SSH_KEY="${TUNNEL_SSH_KEY:-${HOME}/.ssh/id_ed25519}"
FIX_MODE="false"

for arg in "$@"; do
  case "$arg" in
    --fix) FIX_MODE="true" ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

color() {
  case "$1" in
    red)    printf '\033[31m%s\033[0m\n' "$2" ;;
    green)  printf '\033[32m%s\033[0m\n' "$2" ;;
    yellow) printf '\033[33m%s\033[0m\n' "$2" ;;
    *)      echo "$2" ;;
  esac
}

check_port() {
  local port="$1"
  local label="$2"

  local listener
  listener=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1)

  if [ -z "$listener" ]; then
    color yellow "[$label] no listener on port $port — tunnel not up"
    return 1
  fi

  local proc
  proc=$(echo "$listener" | awk '{print $1}')

  if [ "$proc" = "ssh" ]; then
    color green "[$label] OK — SSH tunnel listening on port $port"
    return 0
  fi

  color red "[$label] SHADOW DETECTED — $proc is bound to port $port (NOT ssh)"
  echo "  → This will route gRPC/HTTP to local-sandbox instead of the intended remote."
  echo "  → Process detail:"
  ps -p "$(echo "$listener" | awk '{print $2}')" -o pid,command 2>/dev/null | sed 's/^/    /'

  if [ "$FIX_MODE" = "true" ]; then
    local pid
    pid=$(echo "$listener" | awk '{print $2}')
    safe_kill_shadow "$pid" "$port"
  fi
  return 2
}

# Kill only a process we can positively identify as a local Canton sandbox
# (java/dpm) holding the expected port — never an arbitrary port owner.
# We refuse to touch ssh (that's the tunnel we want) and refuse to kill when
# the match is ambiguous. SIGTERM first, escalate to SIGKILL only if it
# survives.
safe_kill_shadow() {
  local pid="$1"
  local port="$2"

  if ! [ "$pid" -gt 0 ] 2>/dev/null; then
    color yellow "  → --fix: no valid pid resolved for port $port; skipping"
    return 1
  fi

  # Full command line of the holder. The shadow we expect is a JVM-based
  # Canton sandbox launched via dpm/canton/sandbox — not ssh, not anything
  # else.
  local cmd
  cmd=$(ps -p "$pid" -o command= 2>/dev/null)
  if [ -z "$cmd" ]; then
    color yellow "  → --fix: pid $pid no longer present; nothing to kill"
    return 0
  fi

  case "$cmd" in
    *ssh*)
      color yellow "  → --fix: pid $pid looks like an ssh tunnel — refusing to kill"
      return 1
      ;;
  esac

  if ! printf '%s' "$cmd" | grep -Eq '(^|/)(java|dpm|canton)([[:space:]]|$|.*[[:space:]](sandbox|canton)([[:space:]]|$))'; then
    color yellow "  → --fix: pid $pid does not match the expected local Canton sandbox"
    echo "         command: $cmd"
    echo "         refusing to kill an unrecognized process."
    return 1
  fi

  # Guard against a port being held by more than one process — only act when
  # exactly one pid owns it, so --fix can't fan out a kill across unrelated
  # processes.
  local holders
  holders=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u)
  local count
  count=$(printf '%s\n' "$holders" | grep -c '[0-9]')
  if [ "$count" -ne 1 ]; then
    color yellow "  → --fix: ambiguous — $count processes hold port $port; refusing to kill"
    return 1
  fi

  color yellow "  → --fix: sending SIGTERM to local sandbox pid $pid"
  kill -TERM "$pid" 2>/dev/null

  # Give it a moment to exit cleanly before escalating.
  local i
  for i in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then
      color green "  → pid $pid exited after SIGTERM"
      return 0
    fi
    sleep 1
  done

  color yellow "  → pid $pid survived SIGTERM; sending SIGKILL"
  kill -KILL "$pid" 2>/dev/null
  sleep 1
  return 0
}

main() {
  echo "=== check-tunnel: expecting SSH tunnel on $PORT_LEDGER + $PORT_JSON_API ==="
  echo

  local s_ledger s_json
  check_port "$PORT_LEDGER" "ledger gRPC"; s_ledger=$?
  check_port "$PORT_JSON_API" "JSON API";  s_json=$?

  echo

  if [ "$s_ledger" -eq 2 ] || [ "$s_json" -eq 2 ]; then
    if [ "$FIX_MODE" = "true" ]; then
      echo "Killed shadowing processes. Open a new tunnel with:"
    else
      echo "Re-run with --fix to kill shadowing processes, then re-open tunnel:"
    fi
    echo "  ssh -i $SSH_KEY \\"
    echo "      -L 127.0.0.1:${PORT_LEDGER}:${TUNNEL_EXPECTED_REMOTE}:5001 \\"
    echo "      -L 127.0.0.1:${PORT_JSON_API}:${TUNNEL_EXPECTED_REMOTE}:7575 \\"
    echo "      -N -f $BASTION"
    exit 2
  fi

  if [ "$s_ledger" -eq 1 ] && [ "$s_json" -eq 1 ]; then
    echo "Open tunnel with:"
    echo "  ssh -i $SSH_KEY \\"
    echo "      -L 127.0.0.1:${PORT_LEDGER}:${TUNNEL_EXPECTED_REMOTE}:5001 \\"
    echo "      -L 127.0.0.1:${PORT_JSON_API}:${TUNNEL_EXPECTED_REMOTE}:7575 \\"
    echo "      -N -f $BASTION"
    exit 1
  fi

  # Both green — also probe the actual endpoint to confirm the remote
  echo "=== probing JSON API for Canton version ==="
  local version
  version=$(curl -s --max-time 5 "http://127.0.0.1:${PORT_JSON_API}/v2/version" 2>/dev/null | head -c 200)
  if echo "$version" | grep -q '"version"'; then
    color green "  → $version"
    echo
    color green "✅ Tunnel is healthy and routing to a real Canton ledger."
    exit 0
  else
    color red "✗ Could not reach JSON API — tunnel may be broken upstream"
    exit 1
  fi
}

main
