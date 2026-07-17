#!/usr/bin/env bash
set -euo pipefail

# Runs the Daml test runner in each Daml package directory.
# The test runner is per-package, not root-level.
#
# Prefers `dpm test`; falls back to the classic `daml test` (which is what the
# Daml CI workflow installs). Both run every `Script`-typed test in the package.
#
# Only the `test` acceptance suite runs by default. The optional
# `packages/daml/scripts` helper package is source reference for local token
# minting/lifecycle experiments and is not part of the default RC gate; see
# multi-package.yaml for why it is excluded.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAML_DIR="$SCRIPT_DIR/../packages/daml"

if command -v dpm >/dev/null 2>&1; then
  DAML_TEST=(dpm test)
elif command -v daml >/dev/null 2>&1; then
  DAML_TEST=(daml test)
else
  echo "Error: neither 'dpm' nor 'daml' found on PATH; cannot run Daml tests." >&2
  exit 127
fi

PACKAGES=("test")
FAILED=0

for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="$DAML_DIR/$pkg"
  if [ -f "$PKG_DIR/daml.yaml" ]; then
    echo "=== Testing: packages/daml/$pkg ==="
    cd "$PKG_DIR"
    if "${DAML_TEST[@]}"; then
      echo "  PASS"
    else
      echo "  FAIL"
      FAILED=1
    fi
    echo ""
  fi
done

if [ $FAILED -ne 0 ]; then
  echo "Some Daml tests failed!"
  exit 1
fi

echo "All Daml tests passed."
