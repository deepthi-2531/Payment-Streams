#!/usr/bin/env bash
set -euo pipefail

# Downloads Daml Finance library DAR files for the deferred Daml-Finance
# escrow path (main/daml-finance-deferred/). These templates are not part
# of the current build; this script is only needed when that path is
# activated.
#
# NOTE: upstream daml-finance releases are tagged per package
# (e.g. Daml.Finance.Holding.V4/4.0.0) — there is no repo-wide v3.0.0
# DAR bundle, so the download URLs below will not resolve as-is. When
# activating the deferred path: update DAML_FINANCE_VERSION/URLs to the
# real per-package release scheme, run once with
# DAML_FINANCE_ALLOW_UNPINNED=1, and commit the printed checksums into
# EXPECTED_SHA256. Until then the script fails closed by design.
#
# Usage: ./get-dependencies.sh
# Prerequisite: curl must be on PATH.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/main/.lib"

mkdir -p "$LIB_DIR"

# ---------------------------------------------------------------------------
# Daml Finance library DARs (core holding/fungible/transferable interfaces)
# ---------------------------------------------------------------------------

DAML_FINANCE_VERSION="3.0.0"
DAML_FINANCE_REPO="https://github.com/digital-asset/daml-finance/releases/download"

REQUIRED_DARS=(
  "daml-finance-interface-types-common"
  "daml-finance-interface-holding"
  "daml-finance-interface-util"
  "daml-finance-holding"
)

# Expected SHA-256 of each downloaded DAR. A downloaded artifact is verified
# against this map; a mismatch (upstream tamper, release re-cut, MITM) aborts
# the build. Verification is enforced by default: an unpinned DAR fails closed
# rather than silently trusting whatever was downloaded.
#
# To establish trust the first time (or after an intentional version bump),
# run once with DAML_FINANCE_ALLOW_UNPINNED=1, copy the printed sha256 for
# each DAR into EXPECTED_SHA256 below, and commit it.
declare -A EXPECTED_SHA256=(
  # ["daml-finance-interface-types-common"]="<sha256>"
  # ["daml-finance-interface-holding"]="<sha256>"
  # ["daml-finance-interface-util"]="<sha256>"
  # ["daml-finance-holding"]="<sha256>"
)
ALLOW_UNPINNED="${DAML_FINANCE_ALLOW_UNPINNED:-0}"

verify_sha() {
  # $1 = dar name, $2 = file path
  local name="$1" file="$2"
  local actual
  actual="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')"
  [ -z "$actual" ] && actual="$(sha256sum "$file" 2>/dev/null | awk '{print $1}')"
  local expected="${EXPECTED_SHA256[$name]:-}"
  if [ -z "$expected" ]; then
    if [ "$ALLOW_UNPINNED" = "1" ]; then
      echo "  NOTE: $name sha256=$actual — add to EXPECTED_SHA256 and commit"
      return 0
    fi
    echo "  FAILED: no pinned sha256 for $name (refusing trust-on-first-use)."
    echo "    Establish trust explicitly: re-run with DAML_FINANCE_ALLOW_UNPINNED=1,"
    echo "    record the printed sha256 in EXPECTED_SHA256, and commit it."
    rm -f "$file"
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "  FAILED: $name sha256 mismatch"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    rm -f "$file"
    return 1
  fi
  echo "  OK: $name sha256 verified"
  return 0
}

echo "Fetching Daml Finance library DARs (v${DAML_FINANCE_VERSION})..."
echo "Target: $LIB_DIR"
echo ""

FAILED=0

for dar in "${REQUIRED_DARS[@]}"; do
  TARGET_FILE="$LIB_DIR/${dar}.dar"

  if [ -f "$TARGET_FILE" ]; then
    echo "  OK: $dar (already present)"
    verify_sha "$dar" "$TARGET_FILE" || FAILED=1
    continue
  fi

  # Try downloading from GitHub releases
  URL="${DAML_FINANCE_REPO}/v${DAML_FINANCE_VERSION}/${dar}-${DAML_FINANCE_VERSION}.dar"
  echo "  Downloading: $dar..."

  if curl -sSL --fail -o "$TARGET_FILE" "$URL" 2>/dev/null; then
    echo "  OK: $dar (downloaded)"
    verify_sha "$dar" "$TARGET_FILE" || FAILED=1
  else
    # Fallback: try without version suffix in filename
    URL2="${DAML_FINANCE_REPO}/v${DAML_FINANCE_VERSION}/${dar}.dar"
    if curl -sSL --fail -o "$TARGET_FILE" "$URL2" 2>/dev/null; then
      echo "  OK: $dar (downloaded)"
      verify_sha "$dar" "$TARGET_FILE" || FAILED=1
    else
      echo "  FAILED: $dar"
      echo "    Could not download from:"
      echo "      $URL"
      echo "      $URL2"
      rm -f "$TARGET_FILE"
      FAILED=1
    fi
  fi
done

echo ""

if [ $FAILED -ne 0 ]; then
  echo "Some DARs could not be downloaded automatically."
  echo ""
  echo "Manual download options:"
  echo ""
  echo "  Option 1: Download from GitHub releases"
  echo "    https://github.com/digital-asset/daml-finance/releases"
  echo "    Place .dar files in: $LIB_DIR"
  echo ""
  echo "  Option 2: Build from source"
  echo "    git clone https://github.com/digital-asset/daml-finance.git"
  echo "    cd daml-finance && dpm build --all"
  echo "    Then copy the .dar files to: $LIB_DIR"
  echo ""
  echo "  Option 3: Use dpm to fetch (if available in your Daml SDK)"
  echo "    dpm fetch daml-finance-holding --version $DAML_FINANCE_VERSION"
  echo ""
  echo "Required DARs:"
  for dar in "${REQUIRED_DARS[@]}"; do
    echo "  - ${dar}.dar"
  done
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify all DARs are present
# ---------------------------------------------------------------------------

echo "Verifying all required DARs..."
ALL_OK=1
for dar in "${REQUIRED_DARS[@]}"; do
  if [ ! -f "$LIB_DIR/${dar}.dar" ]; then
    echo "  MISSING: $dar"
    ALL_OK=0
  else
    SIZE=$(wc -c < "$LIB_DIR/${dar}.dar" | tr -d ' ')
    if [ "$SIZE" -lt 1000 ]; then
      echo "  CORRUPT: $dar (${SIZE} bytes — expected a valid DAR, not an error page)"
      rm -f "$LIB_DIR/${dar}.dar"
      ALL_OK=0
    else
      echo "  OK: $dar (${SIZE} bytes)"
    fi
  fi
done

if [ $ALL_OK -eq 0 ]; then
  echo ""
  echo "ERROR: Some required DARs are still missing or corrupt."
  exit 1
fi

echo ""
echo "All required Daml Finance DARs present in $LIB_DIR"
echo ""
echo "Next steps:"
echo "  1. Build interfaces:  cd $SCRIPT_DIR/interfaces && daml build"
echo "  2. Build main:        cd $SCRIPT_DIR/main && daml build"
echo "  3. Run tests:         cd $SCRIPT_DIR/test && daml test"
