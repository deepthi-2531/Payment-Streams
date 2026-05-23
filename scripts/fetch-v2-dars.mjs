#!/usr/bin/env node
/**
 * Fetch CIP-56 V2 token-standard DARs from
 * `canton-network/splice@token-standard-v2-upcoming` and place them in
 * `packages/daml/main/.lib/` so the V2 adapter can compile against the
 * real V2 interfaces instead of the stubbed type mirrors.
 *
 * Per the V2-only architectural pivot (STR-79), this fetch is the
 * dependency unlock for the entire M3 critical path:
 *
 *   - Real V2 DARs replace `packages/daml/main/daml/CantonStreams/Settlement/Stubs/`
 *   - Test infrastructure DARs (splice-token-standard-v2-test, splice-test-token-v2)
 *     unlock STR-101: streams acceptance tests use canonical
 *     `Splice.Testing.TokenStandard.WalletClientV2` + `mkAmuletTestCase`
 *     fixtures + `TestIteratedSettlement`-style assertions
 *
 * The script supports three fetch modes, picked via `--mode`:
 *
 *   `--mode source-build` (default)
 *     Clone the Splice repo at the given ref, run `daml build` against
 *     each of the 6 V2 token-standard source packages, copy the
 *     resulting DARs into `packages/daml/main/.lib/`. Requires `git`
 *     and a `daml` SDK ≥ the version pinned by the Splice repo to be
 *     on PATH.
 *
 *   `--mode binary-release`
 *     Try GitHub release artifacts. As of token-standard-v2-upcoming
 *     branch, no binary DARs are published; this mode emits a clear
 *     "not yet published" message and exits with a non-zero status.
 *     Once Splice publishes V2 DARs as release artifacts, this is the
 *     fastest path.
 *
 *   `--mode local`
 *     Use DARs already present in a local clone of the Splice repo
 *     (supplied via `--splice-checkout <path>`). Skips clone + build;
 *     just copies + hashes. Useful in CI when an upstream job built
 *     the DARs already.
 *
 * After successful fetch, follow STR-65's downstream steps:
 *
 *   1. Verify hashes in `packages/daml/main/.lib/V2_DAR_HASHES.json`
 *   2. Uncomment the V2 deps in `packages/daml/main/daml.yaml`
 *   3. Delete `packages/daml/main/daml/CantonStreams/Settlement/Stubs/`
 *   4. Update the 4 import lines in StreamEscrow, StreamFlow,
 *      MilestoneEscrow, AllocationBridge to import from the real
 *      `Splice.Api.Token.*` modules instead of `Settlement.Stubs.*`
 *   5. Remove `-Wno-upgrade-interfaces` from `daml.yaml`
 *   6. Run `daml build --all` to verify
 *   7. Run `scripts/build-template-manifest.mjs` to refresh the
 *      template-id manifest
 *
 * Usage:
 *
 *   node scripts/fetch-v2-dars.mjs                                    # source-build, default ref
 *   node scripts/fetch-v2-dars.mjs --mode source-build --ref <branch>
 *   node scripts/fetch-v2-dars.mjs --mode binary-release --ref v2.0.0
 *   node scripts/fetch-v2-dars.mjs --mode local --splice-checkout /path/to/splice
 *   node scripts/fetch-v2-dars.mjs --dry-run                          # don't write
 *
 * Sources:
 *   - https://github.com/canton-network/splice/tree/token-standard-v2-upcoming/token-standard
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TARGET_DIR = resolve(REPO_ROOT, 'packages/daml/main/.lib');

const SPLICE_REPO_URL = 'https://github.com/canton-network/splice.git';

/**
 * Per the CIP-0112 update (May 2026), V2 packages are versioned
 * 1.0.0 (consistent with splice-api-featured-app-v2). We pin to that
 * version. If Splice ships a later 1.x revision, bump here and re-run.
 *
 * Two sections:
 *   1. INTERFACE packages — bound by `daml.yaml`'s `dependencies` (used
 *      at build time by the templates that implement the V2 interfaces).
 *   2. TEST INFRASTRUCTURE packages — bound by `packages/daml/test/daml.yaml`
 *      only (STR-101). Provide `Splice.Testing.*` fixtures + `WalletClientV2`.
 */
/**
 * V1 interface packages required as build-only data-dependencies by the
 * V2 utils and test infrastructure packages (which dual-implement V1+V2
 * per CIP-0112 §5 even though we, the streams library, are V2-only).
 *
 * `role: 'build-only'` means: build in the temp clone so subsequent
 * dependent builds find the `-current.dar` alias, but do NOT copy to our
 * `.lib/` directory. We don't import these in our own Daml code.
 */
const V1_BUILD_ONLY_DARS = [
  {
    name: 'splice-api-token-holding-v1',
    version: '1.0.0',
    filename: 'splice-api-token-holding-v1-1.0.0.dar',
    location: 'token-standard/splice-api-token-holding-v1',
    role: 'build-only',
  },
  {
    name: 'splice-api-token-transfer-instruction-v1',
    version: '1.0.0',
    filename: 'splice-api-token-transfer-instruction-v1-1.0.0.dar',
    location: 'token-standard/splice-api-token-transfer-instruction-v1',
    role: 'build-only',
  },
  {
    name: 'splice-api-token-allocation-v1',
    version: '1.0.0',
    filename: 'splice-api-token-allocation-v1-1.0.0.dar',
    location: 'token-standard/splice-api-token-allocation-v1',
    role: 'build-only',
  },
  {
    name: 'splice-api-token-allocation-instruction-v1',
    version: '1.0.0',
    filename: 'splice-api-token-allocation-instruction-v1-1.0.0.dar',
    location: 'token-standard/splice-api-token-allocation-instruction-v1',
    role: 'build-only',
  },
  {
    name: 'splice-api-token-allocation-request-v1',
    version: '1.0.0',
    filename: 'splice-api-token-allocation-request-v1-1.0.0.dar',
    location: 'token-standard/splice-api-token-allocation-request-v1',
    role: 'build-only',
  },
];

/**
 * Build-only packages that depend on the V2 interfaces. These must
 * build AFTER all V2_INTERFACE_DARS but BEFORE V2_TEST_INFRASTRUCTURE_DARS.
 *
 * - splice-util-token-standard-wallet (at `daml/` not `token-standard/`)
 *   provides the WalletClientV2 backend used by splice-token-standard-v2-test.
 */
const POST_V2_BUILD_ONLY_DARS = [
  {
    name: 'splice-util-token-standard-wallet',
    version: '1.0.0',
    filename: 'splice-util-token-standard-wallet-1.0.0.dar',
    location: 'daml/splice-util-token-standard-wallet',
    role: 'build-only',
  },
];

const V2_INTERFACE_DARS = [
  {
    name: 'splice-api-token-metadata-v1',
    version: '1.0.0',
    filename: 'splice-api-token-metadata-v1-1.0.0.dar',
    location: 'token-standard/splice-api-token-metadata-v1',
    role: 'interface',
  },
  {
    name: 'splice-api-token-holding-v2',
    version: '1.0.0',
    filename: 'splice-api-token-holding-v2-1.0.0.dar',
    location: 'token-standard/splice-api-token-holding-v2',
    role: 'interface',
  },
  {
    name: 'splice-api-token-transfer-instruction-v2',
    version: '1.0.0',
    filename: 'splice-api-token-transfer-instruction-v2-1.0.0.dar',
    location: 'token-standard/splice-api-token-transfer-instruction-v2',
    role: 'interface',
  },
  {
    name: 'splice-api-token-allocation-v2',
    version: '1.0.0',
    filename: 'splice-api-token-allocation-v2-1.0.0.dar',
    location: 'token-standard/splice-api-token-allocation-v2',
    role: 'interface',
  },
  {
    name: 'splice-api-token-allocation-instruction-v2',
    version: '1.0.0',
    filename: 'splice-api-token-allocation-instruction-v2-1.0.0.dar',
    location: 'token-standard/splice-api-token-allocation-instruction-v2',
    role: 'interface',
  },
  {
    name: 'splice-api-token-allocation-request-v2',
    version: '1.0.0',
    filename: 'splice-api-token-allocation-request-v2-1.0.0.dar',
    location: 'token-standard/splice-api-token-allocation-request-v2',
    role: 'interface',
  },
  {
    name: 'splice-api-token-transfer-events-v2',
    version: '1.0.0',
    filename: 'splice-api-token-transfer-events-v2-1.0.0.dar',
    location: 'token-standard/splice-api-token-transfer-events-v2',
    role: 'interface',
  },
  {
    name: 'splice-token-standard-utils',
    version: '1.0.0',
    filename: 'splice-token-standard-utils-1.0.0.dar',
    location: 'token-standard/splice-token-standard-utils',
    role: 'interface',
  },
];

const V2_TEST_INFRASTRUCTURE_DARS = [
  {
    name: 'splice-test-token-v2',
    version: '1.0.0',
    filename: 'splice-test-token-v2-1.0.0.dar',
    location: 'token-standard/examples/splice-test-token-v2',
    role: 'test',
  },
  {
    name: 'splice-token-test-trading-app-v2',
    version: '1.0.0',
    filename: 'splice-token-test-trading-app-v2-1.0.0.dar',
    location: 'token-standard/examples/splice-token-test-trading-app-v2',
    role: 'test',
  },
  {
    name: 'splice-token-standard-v2-test',
    version: '1.0.0',
    filename: 'splice-token-standard-v2-test-1.0.0.dar',
    location: 'token-standard/splice-token-standard-v2-test',
    role: 'test',
  },
];

// Order matters for the source-build path because each package's
// `daml build` resolves data-dependencies from sibling `.daml/dist/`
// directories. Required order:
//
//   1. metadata-v1 — depended on by everything else
//   2. V1 build-only packages — depended on by utils + test infrastructure
//      (which dual-implement V1+V2 per CIP-0112 §5 even though we
//      ourselves are V2-only)
//   3. V2 interface packages — depend on metadata-v1
//   4. utils + test infrastructure packages — depend on V1 + V2
//
// `splice-api-token-metadata-v1` is defined in V2_INTERFACE_DARS but
// must build first. Slice it out and prepend.
const METADATA_V1 = V2_INTERFACE_DARS.find(
  (d) => d.name === 'splice-api-token-metadata-v1',
);
const OTHER_V2_INTERFACES = V2_INTERFACE_DARS.filter(
  (d) => d.name !== 'splice-api-token-metadata-v1',
);
const DAR_SOURCES = [
  METADATA_V1,
  ...V1_BUILD_ONLY_DARS,
  ...OTHER_V2_INTERFACES,
  ...POST_V2_BUILD_ONLY_DARS,
  ...V2_TEST_INFRASTRUCTURE_DARS,
].filter(Boolean);

function parseArgs(argv) {
  const args = {
    ref: 'token-standard-v2-upcoming',
    mode: 'source-build',
    dryRun: false,
    spliceCheckout: null,
    keepClone: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') args.ref = argv[++i];
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--splice-checkout') args.spliceCheckout = argv[++i];
    else if (a === '--keep-clone') args.keepClone = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage() {
  console.error('Usage: fetch-v2-dars.mjs [options]');
  console.error('');
  console.error('Options:');
  console.error('  --mode source-build    Clone Splice + daml build each V2 package (default)');
  console.error('  --mode binary-release  Try GitHub release artifacts (currently not published)');
  console.error('  --mode local           Use a local Splice checkout (requires --splice-checkout)');
  console.error('  --ref <branch>         Splice branch/tag (default: token-standard-v2-upcoming)');
  console.error('  --splice-checkout PATH Local Splice checkout for --mode local');
  console.error('  --keep-clone           Don\'t delete the temporary clone after build');
  console.error('  --dry-run              Print what would happen, don\'t write');
  console.error('');
  console.error('Output:');
  console.error('  ' + TARGET_DIR + '/<dar-filename>');
  console.error('  ' + TARGET_DIR + '/V2_DAR_HASHES.json');
}

function log(...args) {
  console.error('[v2-fetch]', ...args);
}

function execSync(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${r.status}`);
  }
}

function execCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited with status ${r.status}: ${r.stderr || r.stdout || ''}`,
    );
  }
  return (r.stdout || '').trim();
}

function checkToolAvailable(cmd) {
  // Different tools take different version flags. `daml` uses
  // `daml version` (no leading `--`); most other tools accept `--version`.
  // We try both and accept any successful invocation.
  const versionFlag = cmd === 'daml' ? 'version' : '--version';
  const r = spawnSync(cmd, [versionFlag], { encoding: 'utf8' });
  if (!r.error && r.status === 0) return true;
  // Fallback for tools that print version on `-v`.
  const r2 = spawnSync(cmd, ['-v'], { encoding: 'utf8' });
  return !r2.error && r2.status === 0;
}

// ---------------------------------------------------------------------------
// Mode: source-build
// ---------------------------------------------------------------------------

async function modeSourceBuild(args) {
  if (!checkToolAvailable('git')) {
    throw new Error('source-build mode requires `git` on PATH');
  }
  if (!checkToolAvailable('daml')) {
    throw new Error(
      'source-build mode requires `daml` SDK on PATH. Install via ' +
      'https://docs.digitalasset.com/build/3.4/getting-started/installation.html ' +
      'or use --mode local with a pre-built checkout.',
    );
  }

  const tmpDir = resolve(tmpdir(), `splice-v2-fetch-${Date.now()}`);
  log(`Cloning splice@${args.ref} into ${tmpDir}`);
  if (!args.dryRun) {
    execSync('git', [
      'clone',
      '--depth=1',
      '--branch', args.ref,
      SPLICE_REPO_URL,
      tmpDir,
    ]);
  }

  try {
    return await buildAndCollect(tmpDir, args);
  } finally {
    if (!args.keepClone && !args.dryRun && existsSync(tmpDir)) {
      execSync('rm', ['-rf', tmpDir]);
    }
  }
}

// ---------------------------------------------------------------------------
// Mode: binary-release
// ---------------------------------------------------------------------------

async function modeBinaryRelease(args) {
  log(`Trying binary release artifacts at ref=${args.ref}`);
  const results = {};
  for (const dar of DAR_SOURCES) {
    const url = `https://github.com/canton-network/splice/releases/download/${encodeURIComponent(args.ref)}/${dar.filename}`;
    log(`→ ${url}`);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log(`  ✗ HTTP ${res.status}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      results[dar.filename] = bytes;
      log(`  ✓ ${bytes.length} bytes`);
    } catch (err) {
      log(`  ✗ ${err.message ?? err}`);
    }
  }
  if (Object.keys(results).length === 0) {
    log('');
    log('No binary release artifacts found.');
    log('As of token-standard-v2-upcoming, Splice does not publish V2 DARs');
    log('as GitHub release binaries. Use --mode source-build instead, or');
    log('--mode local if you have a Splice checkout that already contains');
    log('the built DARs.');
    process.exit(2);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Mode: local
// ---------------------------------------------------------------------------

async function modeLocal(args) {
  if (!args.spliceCheckout) {
    throw new Error('--mode local requires --splice-checkout <path>');
  }
  const checkout = resolve(args.spliceCheckout);
  if (!existsSync(checkout)) {
    throw new Error(`splice checkout does not exist: ${checkout}`);
  }
  return buildAndCollect(checkout, args);
}

// ---------------------------------------------------------------------------
// Build + collect (shared between source-build and local modes)
// ---------------------------------------------------------------------------

async function buildAndCollect(spliceRoot, args) {
  if (args.dryRun) {
    log('(dry-run) Would build each of these packages from ' + spliceRoot + ':');
    for (const dar of DAR_SOURCES) {
      log(`  - ${dar.name} → ${dar.filename}`);
    }
    // Return a synthetic non-empty result so the summary path runs.
    // Bytes are fake; nothing gets written because dryRun is checked
    // again in writeDars.
    const fake = {};
    for (const dar of DAR_SOURCES) {
      fake[dar.filename] = Buffer.from('(dry-run placeholder)');
    }
    return fake;
  }
  const results = {};
  for (const dar of DAR_SOURCES) {
    // Each DAR carries its location relative to the splice repo root.
    // Interface packages: token-standard/<name>
    // Test infrastructure: token-standard/examples/<name> or token-standard/<name>
    const pkgRoot = resolve(spliceRoot, dar.location);
    if (!existsSync(pkgRoot)) {
      log(`✗ ${dar.name}: package dir not found at ${pkgRoot}`);
      continue;
    }
    log(`→ building ${dar.name}`);
    try {
      // IMPORTANT: do NOT pass `--output`. The Splice packages depend
      // on each other's default-named DARs (`<name>-current.dar` or
      // `<name>-<version>.dar` per their own daml.yaml). Passing
      // `--output` here would rename the produced DAR and break the
      // build of subsequent packages that resolve dependencies from
      // sibling `.daml/dist/` directories.
      execSync('daml', ['build'], { cwd: pkgRoot });
    } catch (err) {
      log(`  ✗ daml build failed for ${dar.name}: ${err.message ?? err}`);
      continue;
    }
    // Find the produced DAR. daml writes to `.daml/dist/<name>-<version>.dar`
    // where <version> comes from the package's own daml.yaml. Upstream
    // splice packages use `version: 1.0.0` but their dependents reference
    // `<name>-current.dar` (the DPM-tool default for in-development builds).
    // We copy the built DAR to the `-current.dar` filename in the SAME dist
    // dir so subsequent dependent builds resolve their data-dependencies.
    const distDir = resolve(pkgRoot, '.daml/dist');
    if (!existsSync(distDir)) {
      log(`  ✗ no .daml/dist/ produced for ${dar.name}`);
      continue;
    }
    const entries = readdirSync(distDir)
      .filter((f) => f.startsWith(`${dar.name}-`) && f.endsWith('.dar'));
    if (entries.length === 0) {
      log(`  ✗ no DAR matching ${dar.name}-*.dar in ${distDir}`);
      continue;
    }
    // Prefer the one our manifest expects; otherwise take the first one.
    const actualName = entries.includes(dar.filename) ? dar.filename : entries[0];
    const builtDar = resolve(distDir, actualName);
    const bytes = readFileSync(builtDar);

    // Provide the `-current.dar` alias so subsequent dependent builds
    // resolve their `../splice-api-token-*/.daml/dist/<name>-current.dar`
    // data-dependencies (DPM tool's default name).
    const currentAlias = resolve(distDir, `${dar.name}-current.dar`);
    if (!existsSync(currentAlias)) {
      writeFileSync(currentAlias, bytes);
    }

    // Key results by the manifest filename (our normalized name), but
    // record both names in the hashes file for traceability.
    results[dar.filename] = { bytes, actualName };
    log(`  ✓ built ${actualName} → ${dar.filename} (${bytes.length} bytes; ${dar.name}-current.dar aliased)`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Common write + hash
// ---------------------------------------------------------------------------

function writeDars(results, args) {
  if (!args.dryRun) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }
  const hashes = {};
  let fetchedCount = 0;
  for (const dar of DAR_SOURCES) {
    // `build-only` DARs are built in the temp clone to satisfy data-
    // dependencies of subsequent V2 / test packages, but never copied to
    // our .lib/ — we don't import V1 interfaces in our own Daml code.
    if (dar.role === 'build-only') {
      continue;
    }
    const entry = results[dar.filename];
    if (!entry) continue;
    // Accept legacy Buffer-only shape (binary-release / dry-run paths)
    // alongside the new `{ bytes, actualName }` shape from source-build.
    const bytes = Buffer.isBuffer(entry) ? entry : entry.bytes;
    const actualName = Buffer.isBuffer(entry) ? dar.filename : entry.actualName;
    if (!bytes) continue;
    const sha = createHash('sha256').update(bytes).digest('hex');
    const target = resolve(TARGET_DIR, dar.filename);
    if (!args.dryRun) writeFileSync(target, bytes);
    const prefix = args.dryRun ? '(dry-run; would write)' : '✓';
    const renameNote = actualName !== dar.filename ? ` (built as ${actualName})` : '';
    log(`${prefix} ${dar.filename}${renameNote} (${bytes.length} bytes, sha256=${sha.slice(0, 16)}…)`);
    hashes[dar.filename] = {
      size: bytes.length,
      sha256: sha,
      source: `splice@${args.ref}/${dar.location ?? `token-standard/${dar.name}`}`,
      ...(actualName !== dar.filename ? { actualName } : {}),
    };
    fetchedCount++;
  }
  if (fetchedCount > 0 && !args.dryRun) {
    const hashFile = resolve(TARGET_DIR, 'V2_DAR_HASHES.json');
    writeFileSync(
      hashFile,
      JSON.stringify(
        {
          ref: args.ref,
          fetchedAt: new Date().toISOString(),
          mode: args.mode,
          dars: hashes,
        },
        null,
        2,
      ) + '\n',
    );
    log(`✓ wrote ${hashFile}`);
  }
  return fetchedCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  log(`mode=${args.mode} ref=${args.ref} dry-run=${args.dryRun} target=${TARGET_DIR}`);

  let results;
  switch (args.mode) {
    case 'source-build':
      results = await modeSourceBuild(args);
      break;
    case 'binary-release':
      results = await modeBinaryRelease(args);
      break;
    case 'local':
      results = await modeLocal(args);
      break;
    default:
      throw new Error(`Unknown --mode: ${args.mode}`);
  }

  const fetchedCount = writeDars(results, args);
  log('');
  log(`Summary: ${fetchedCount} of ${DAR_SOURCES.length} DARs fetched.`);

  if (fetchedCount === DAR_SOURCES.length) {
    log('');
    log('Next steps (V2-only per STR-79):');
    log('');
    log(' Interface adoption (unblocks STR-86 / STR-87 / STR-88):');
    log('  1. Add V2 interface DARs to packages/daml/main/daml.yaml dependencies:');
    log('       - .lib/splice-api-token-metadata-v1-1.0.0.dar');
    log('       - .lib/splice-api-token-holding-v2-1.0.0.dar');
    log('       - .lib/splice-api-token-allocation-v2-1.0.0.dar');
    log('       - .lib/splice-api-token-allocation-request-v2-1.0.0.dar');
    log('       - .lib/splice-api-token-allocation-instruction-v2-1.0.0.dar');
    log('       - .lib/splice-api-token-transfer-events-v2-1.0.0.dar');
    log('       - .lib/splice-token-standard-utils-1.0.0.dar');
    log('  2. Delete packages/daml/main/daml/CantonStreams/Settlement/Stubs/');
    log('  3. Update imports in StreamEscrow / StreamFlow / MilestoneEscrow / AllocationBridge:');
    log('       - import qualified CantonStreams.Settlement.Stubs.AllocationRequestV2 as AR2');
    log('       + import qualified Splice.Api.Token.AllocationRequestV2 as AR2');
    log('  4. Remove -Wno-upgrade-interfaces from packages/daml/main/daml.yaml build-options');
    log('  5. Run `daml build --all` to verify');
    log('  6. Run `scripts/build-template-manifest.mjs` to refresh the manifest');
    log('');
    log(' Test infrastructure adoption (unblocks STR-89 + STR-101):');
    log('  7. Add test DARs to packages/daml/test/daml.yaml dependencies:');
    log('       - .lib/splice-test-token-v2-1.0.0.dar');
    log('       - .lib/splice-token-test-trading-app-v2-1.0.0.dar');
    log('       - .lib/splice-token-standard-v2-test-1.0.0.dar');
    log('  8. Replace synthetic test scaffolding with Splice.Testing.* imports:');
    log('       + import Splice.Testing.Registries.AmuletRegistryV2 (mkAmuletTestCase)');
    log('       + import qualified Splice.Testing.TokenStandard.WalletClientV2 as WalletClientV2');
    log('  9. Rewrite Test/Stream/V2WalletOnly.daml as a thin wrapper over the canonical fixtures');
    log('     (mirrors splice-token-standard-v2-test/Tests/TestIteratedSettlement.daml)');
  } else if (fetchedCount > 0) {
    log('');
    log('PARTIAL fetch — some DARs failed to build/fetch. Check logs above.');
    process.exit(2);
  } else {
    log('');
    log('No DARs fetched. See errors above.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[FATAL]', err.message ?? err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
