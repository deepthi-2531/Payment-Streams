#!/usr/bin/env bash
set -euo pipefail

# Propagates exact versions from versions.json to all package.json files.
# Run this after updating versions.json.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_FILE="$SCRIPT_DIR/versions.json"

if [ ! -f "$VERSIONS_FILE" ]; then
  echo "Error: versions.json not found at $VERSIONS_FILE"
  exit 1
fi

echo "Syncing versions from versions.json..."

# Extract the Daml SDK version
DAML_SDK_VERSION=$(python3 -c "import json; print(json.load(open('$VERSIONS_FILE'))['daml-sdk'])")
echo "  Daml SDK: $DAML_SDK_VERSION"

# Update all daml.yaml files with the SDK version
find "$SCRIPT_DIR/packages/daml" -name "daml.yaml" -exec \
  sed -i '' "s/^sdk-version:.*/sdk-version: $DAML_SDK_VERSION/" {} \;

echo "Done. Verify changes with: git diff"
