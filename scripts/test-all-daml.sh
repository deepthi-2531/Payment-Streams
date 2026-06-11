#!/usr/bin/env bash
set -euo pipefail

# Runs dpm test in each Daml package directory.
# dpm test is per-package, not root-level.
#
# Only the `test` acceptance suite runs by default. The optional
# `packages/daml/scripts` helper package is source reference for local token
# minting/lifecycle experiments and is not part of the default RC gate; see
# multi-package.yaml for why it is excluded.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAML_DIR="$SCRIPT_DIR/../packages/daml"

PACKAGES=("test")
FAILED=0

for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="$DAML_DIR/$pkg"
  if [ -f "$PKG_DIR/daml.yaml" ]; then
    echo "=== Testing: packages/daml/$pkg ==="
    cd "$PKG_DIR"
    if dpm test; then
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
