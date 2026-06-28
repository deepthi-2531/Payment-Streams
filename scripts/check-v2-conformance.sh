#!/usr/bin/env bash
#
# Fail-on-find lint for V2 Token Standard conformance.
#
# Blocks accidental introduction of identifiers that don't exist in the
# upstream CIP-56 V2 surface, typically because a V1 identifier leaked into
# the V2 path. The intentional transitional V1 lane is allowlisted below and
# should be deleted from the allowlist when that lane is retired.
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
  'docs/E2E-HARNESS.md'                    # documents why V1 names are rejected and what the CI guard does
  # Daml templates may carry "don't invent this; V2 uses X" warning comments
  # that explicitly steer contributors away from forbidden V1 names.
  'packages/daml/main/daml/CantonStreams/Stream/MilestoneAdmin.daml'
  # Transitional V1 settlement lane — intentionally speaks the V1 token
  # standard vocabulary. Delete these entries when the lane is retired.
  'packages/sdk/src/commands/allocation-v1.ts'
  'packages/sdk/test/commands/allocation-v1.test.ts'
  'packages/sdk/test/settlement/allocation-dispatch-v1.test.ts'
  'packages/sdk/src/settlement/choice-context.ts'
  'packages/daml/v1-shim/daml/CantonStreams/V1Shim/AllocationRequestShim.daml'
  'packages/daml/v1-shim/test/daml/Test/V1Shim/AllocationRequestShimTest.daml'
  'packages/daml/v1-shim/daml/CantonStreams/V1Shim/ReceiverClaim.daml'
  'packages/daml/v1-shim/test/daml/Test/V1Shim/ReceiverClaimTest.daml'
  'scripts/devnet-v1-cc-stream-probe.mjs'
  'docs/V1-LANE-TESTING.md'
  'docs/reports/first-dapp-integration-testnet.md'
  'docs/reports/mainnet-external-stream-2026-06-10.md'
  # Docs that legitimately discuss the V1 lane / audit scope by name.
  'docs/AUDIT-SCOPE.md'
  'docs/validation/usdcx-field-validation.md'
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
Token Standard surface.
If you genuinely need to reference a forbidden name (e.g. a migration
note), add the file to ALLOWED_FILES in scripts/check-v2-conformance.sh
with a comment explaining why.
MSG

exit 1
