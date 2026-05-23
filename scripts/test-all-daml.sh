#!/usr/bin/env bash
set -euo pipefail

# Runs dpm test in each Daml package directory.
# dpm test is per-package, not root-level.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAML_DIR="$SCRIPT_DIR/../packages/daml"

PACKAGES=("test" "scripts")
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
