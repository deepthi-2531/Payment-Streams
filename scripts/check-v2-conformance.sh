#!/usr/bin/env bash
#
# Fail-on-find lint for V2 Token Standard conformance.
#
# Blocks accidental introduction of identifiers that don't exist in the
# upstream CIP-56 V2 surface (`canton-network/splice@token-standard-v2-upcoming`),
# typically because they were V1 names from a deleted code path or
# stub-era inventions that pre-dated the V2-only pivot.
#
# Run by CI on every push + PR.
#
# Maintainer override: if a future upstream rename re-introduces one of
# the forbidden names legitimately, add it to ALLOWED_FILES below with
# a comment explaining why and update this lint.

set -euo pipefail

# ---------------------------------------------------------------------------
# Forbidden identifiers + the reason they're forbidden.
#
# Each entry is `pattern|short reason`.
# ---------------------------------------------------------------------------
FORBIDDEN=(
  'Allocation_ExecuteTransfer|V1 choice name; V2 uses Allocation_Settle'
  'extraArgs\.legId|Not part of V2 spec; per-leg routing is via extraTransferLegSides'
)

# ---------------------------------------------------------------------------
# Files where a forbidden mention is allowed because the file explicitly
# documents "this is NOT V2" / "removed from V2".
# ---------------------------------------------------------------------------
ALLOWED_FILES=(
  'scripts/check-v2-conformance.sh'        # this file references the forbidden names by definition
  'CHANGELOG.md'                           # may legitimately log a rename
  'docs/integration-guide/cip-56-v2-types-reference.md'  # may show "V1 had X; V2 has Y" comparison
  # Daml templates may carry "don't invent this; V2 uses X" warning comments
  # that explicitly steer contributors away from forbidden V1 names.
  'packages/daml/main/daml/CantonStreams/Stream/MilestoneAdmin.daml'
)

# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------
INCLUDES=(
  '--include=*.md' '--include=*.ts' '--include=*.tsx'
  '--include=*.js' '--include=*.mjs' '--include=*.daml'
  '--include=*.json' '--include=*.yaml'
)

EXCLUDES=(
  '--exclude-dir=node_modules'
  '--exclude-dir=.git'
  '--exclude-dir=.daml'
  '--exclude-dir=.lib'
  '--exclude-dir=dist'
)

fail=0

tmp_hits="$(mktemp)"
trap 'rm -f "$tmp_hits"' EXIT

for entry in "${FORBIDDEN[@]}"; do
  pattern="${entry%%|*}"
  reason="${entry##*|}"

  grep -rnE "$pattern" "${INCLUDES[@]}" "${EXCLUDES[@]}" . 2>/dev/null > "$tmp_hits" || true

  if [ ! -s "$tmp_hits" ]; then
    continue
  fi

  any=0
  while IFS= read -r line; do
    file="${line%%:*}"
    file="${file#./}"
    allowed=0
    for af in "${ALLOWED_FILES[@]}"; do
      if [ "$file" = "$af" ]; then
        allowed=1
        break
      fi
    done
    if [ "$allowed" -eq 0 ]; then
      if [ "$any" -eq 0 ]; then
        echo "FAIL: '$pattern' — $reason"
        any=1
      fi
      echo "  $line"
    fi
  done < "$tmp_hits"

  if [ "$any" -eq 1 ]; then
    echo
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "OK: V2 conformance lint passes."
  exit 0
fi

cat <<MSG

—
This lint blocks identifiers that do not exist in the upstream V2
Token Standard surface (canton-network/splice@token-standard-v2-upcoming).
If you genuinely need to reference a forbidden name (e.g. a migration
note), add the file to ALLOWED_FILES in scripts/check-v2-conformance.sh
with a comment explaining why.
MSG

exit 1
