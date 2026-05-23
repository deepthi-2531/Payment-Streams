#!/usr/bin/env bash
set -euo pipefail

# Generates golden accrual fixtures from Daml test output for SDK parity tests.
# Prerequisite: Daml packages must be built first (dpm build --all)
#
# The Daml tests emit debug lines in the format:
#   GOLDEN:<test>:<field>:<value>
# e.g.:
#   GOLDEN:linear_create:totalDeposited:1000.0
#   GOLDEN:linear_partial_withdraw:accrued:500.0
#   GOLDEN:invariant:linear:r=500.0,w=500.0,tw=0.0,ok=True
#
# This script parses those colon-delimited strings into structured JSON.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/packages/sdk/test/fixtures"
FIXTURE_FILE="$FIXTURE_DIR/accrual-golden.json"

mkdir -p "$FIXTURE_DIR"

echo "Running Daml tests to extract golden accrual values..."

cd "$SCRIPT_DIR/packages/daml/test"

# Run tests and extract golden lines, then parse colon-delimited format to JSON.
# The grep strips Daml debug prefix (e.g. "  Trace: ") and captures everything after GOLDEN:
dpm test 2>&1 | grep "GOLDEN:" | sed 's/.*GOLDEN://' | python3 -c "
import sys, json, re

fixtures = {}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    # Parse colon-delimited format: test:field:value
    # Some lines have comma-separated key=value pairs in the value part
    # e.g. 'invariant:linear:r=500.0,w=500.0,tw=0.0,ok=True'
    parts = line.split(':', 2)  # Split into at most 3 parts
    if len(parts) < 2:
        continue

    test_name = parts[0]
    field_name = parts[1] if len(parts) >= 2 else ''
    value = parts[2] if len(parts) >= 3 else ''

    if test_name not in fixtures:
        fixtures[test_name] = {}

    # Try to parse key=value pairs (for invariant checks)
    if '=' in value and ',' in value:
        kv_pairs = {}
        for kv in value.split(','):
            if '=' in kv:
                k, v = kv.split('=', 1)
                k = k.strip()
                v = v.strip()
                # Convert types
                if v in ('True', 'False'):
                    kv_pairs[k] = v == 'True'
                else:
                    try:
                        kv_pairs[k] = float(v)
                    except ValueError:
                        kv_pairs[k] = v
        fixtures[test_name][field_name] = kv_pairs
    else:
        # Single value — try numeric conversion
        value = value.strip()
        if value in ('True', 'False'):
            fixtures[test_name][field_name] = value == 'True'
        elif value in ('Active', 'Completed', 'Cancelled'):
            fixtures[test_name][field_name] = value
        else:
            try:
                fixtures[test_name][field_name] = float(value)
            except ValueError:
                fixtures[test_name][field_name] = value

result = {
    'generated': True,
    'source': 'dpm test output',
    'format': 'GOLDEN:<test>:<field>:<value>',
    'fixtures': fixtures,
}

with open('$FIXTURE_FILE', 'w') as f:
    json.dump(result, f, indent=2)

count = sum(len(v) for v in fixtures.values())
print(f'Wrote {count} golden values across {len(fixtures)} test groups to $FIXTURE_FILE')
"

echo "Done. SDK parity tests will use $FIXTURE_FILE"
