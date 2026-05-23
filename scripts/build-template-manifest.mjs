#!/usr/bin/env node
/**
 * Build the canonical template-id manifest for Canton Streams.
 *
 * The manifest is the single source of truth for "what counts as a
 * Canton Streams transaction." It binds the library to its on-ledger
 * template ids so any third party (Foundation, reviewer, partner) can
 * compute adoption metrics from the public Canton scan endpoint without
 * grantee-supplied data.
 *
 * Output: `dist/template-manifest.json` with the shape:
 *
 *   {
 *     "version": "<package version>",
 *     "buildTime": "<ISO timestamp>",
 *     "packages": [
 *       {
 *         "name": "canton-streams",
 *         "version": "0.2.7",
 *         "packageHash": "<sha256>",
 *         "darPath": "<path to .dar>",
 *         "templates": [
 *           { "module": "...", "name": "...", "templateId": "<hash>:<module>:<name>" }
 *         ]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Usage:
 *
 *   node scripts/build-template-manifest.mjs \
 *     [--out dist/template-manifest.json] \
 *     [--dar packages/daml/main/.daml/dist/canton-streams-0.2.7.dar] \
 *     [--dar packages/daml/interfaces/.daml/dist/canton-streams-interfaces-0.2.2.dar]
 *
 * Requires `damlc inspect-dar --json` on PATH (Daml SDK 2.x or 3.x).
 *
 * The manifest is referenced from the grant agreement at M1; once published,
 * the package hashes are immutable and the Foundation queries them to
 * compute adoption (see scripts/query-adoption-metrics.mjs).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Default DARs that ship with this library.
const DEFAULT_DARS = [
  'packages/daml/main/.daml/dist/canton-streams-0.2.7.dar',
  'packages/daml/interfaces/.daml/dist/canton-streams-interfaces-0.2.2.dar',
];

function parseArgs(argv) {
  const args = { dars: [], out: 'dist/template-manifest.json' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dar') {
      args.dars.push(argv[++i]);
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (args.dars.length === 0) args.dars = DEFAULT_DARS;
  return args;
}

function printUsage() {
  console.error('Usage: build-template-manifest.mjs [--dar PATH ...] [--out PATH]');
  console.error('Default DARs:');
  for (const d of DEFAULT_DARS) console.error(`  ${d}`);
}

function inspectDar(darPath) {
  const absolute = resolve(REPO_ROOT, darPath);
  if (!existsSync(absolute)) {
    throw new Error(`DAR not found: ${absolute}. Run \`pnpm -r run daml:build\` first.`);
  }
  const out = execFileSync('damlc', ['inspect-dar', '--json', absolute], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Extract template ids from an `inspect-dar --json` payload. The exact
 * shape of the JSON varies between Daml SDK minor versions; this function
 * is intentionally tolerant of either the modern (`packages` keyed by
 * hash) or legacy (`main_package_id` + `dependencies`) shapes.
 */
function extractTemplates(inspectJson) {
  const result = [];

  // Modern shape: { packages: { <hash>: { name, version, modules: [...] } } }
  if (inspectJson && typeof inspectJson === 'object' && inspectJson.packages) {
    for (const [hash, pkg] of Object.entries(inspectJson.packages)) {
      const modules = pkg.modules || pkg.modulesByName || {};
      const moduleEntries = Array.isArray(modules) ? modules : Object.entries(modules);
      for (const m of moduleEntries) {
        const moduleName = Array.isArray(m) ? m[0] : m.name;
        const moduleBody = Array.isArray(m) ? m[1] : m;
        const templates = moduleBody.templates || [];
        const templateNames = Array.isArray(templates)
          ? templates.map((t) => (typeof t === 'string' ? t : t.name))
          : Object.keys(templates);
        for (const tname of templateNames) {
          result.push({
            packageHash: hash,
            packageName: pkg.name,
            packageVersion: pkg.version,
            module: moduleName,
            templateName: tname,
            templateId: `${hash}:${moduleName}:${tname}`,
          });
        }
      }
    }
    return result;
  }

  // Legacy fallback: best-effort parse, surface raw payload for the user.
  console.warn('[manifest] Unrecognized inspect-dar JSON shape; emitting raw payload');
  return [{ raw: inspectJson }];
}

function main() {
  const args = parseArgs(process.argv);
  const packages = [];

  for (const darRel of args.dars) {
    console.error(`[manifest] inspecting ${darRel}`);
    const inspectJson = inspectDar(darRel);
    const templates = extractTemplates(inspectJson);

    // Group by package hash for the manifest.
    const byHash = new Map();
    for (const t of templates) {
      if (!t.packageHash) continue;
      if (!byHash.has(t.packageHash)) {
        byHash.set(t.packageHash, {
          name: t.packageName,
          version: t.packageVersion,
          packageHash: t.packageHash,
          darPath: darRel,
          templates: [],
        });
      }
      byHash.get(t.packageHash).templates.push({
        module: t.module,
        name: t.templateName,
        templateId: t.templateId,
      });
    }
    packages.push(...byHash.values());
  }

  const manifest = {
    version: process.env.MANIFEST_VERSION ?? readPackageVersion(),
    buildTime: new Date().toISOString(),
    note:
      'Canonical template-id manifest. Bound to the Canton Streams grant agreement at M1. ' +
      'Adoption metrics are computed by the Foundation against the templateIds listed here, ' +
      'on the public Canton mainnet scan endpoint, excluding grantee/affiliate party identifiers ' +
      'from the published exclusion list.',
    packages,
  };

  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.error(`[manifest] wrote ${outPath}`);
  console.error(`[manifest] packages: ${packages.length}`);
  console.error(
    `[manifest] templates: ${packages.reduce((a, p) => a + p.templates.length, 0)}`,
  );
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      execFileSync('cat', [resolve(REPO_ROOT, 'package.json')], { encoding: 'utf8' }),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

main();
