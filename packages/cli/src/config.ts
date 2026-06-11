/**
 * @module config
 *
 * Loads CLI configuration from ~/.canton-streams.yaml, environment variables,
 * and command-line flags. Priority (highest to lowest):
 *   1. CLI flags
 *   2. Environment variables
 *   3. YAML config file
 *   4. Built-in defaults
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import type { ClientConfig } from '@canton-streams/sdk';

/** Shape of the YAML config file. */
interface FileConfig {
  host?: string;
  port?: number;
  tls?: boolean;
  token?: string;
  party?: string;
}

/** CLI global options as parsed by yargs. */
export interface GlobalOptions {
  host?: string;
  port?: number;
  tls?: boolean;
  token?: string;
  party?: string;
}

const CONFIG_FILENAME = '.canton-streams.yaml';
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 6865;

/**
 * Load file-based configuration from ~/.canton-streams.yaml.
 * Returns an empty object if the file does not exist or is unparseable.
 */
function loadFileConfig(): FileConfig {
  const configPath = join(homedir(), CONFIG_FILENAME);
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    return (parsed && typeof parsed === 'object') ? parsed as FileConfig : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the effective configuration by merging defaults, file config,
 * environment variables, and CLI flags (in ascending priority order).
 */
export function resolveConfig(argv: GlobalOptions): ClientConfig {
  const file = loadFileConfig();

  const host =
    argv.host ??
    process.env['CANTON_HOST'] ??
    file.host ??
    DEFAULT_HOST;

  const port =
    argv.port ??
    (process.env['CANTON_PORT'] ? Number(process.env['CANTON_PORT']) : undefined) ??
    file.port ??
    DEFAULT_PORT;

  const useTls =
    argv.tls ??
    (process.env['CANTON_TLS'] === 'true' ? true : undefined) ??
    file.tls ??
    false;

  // Token comes from the environment or config file only — never a
  // CLI flag (process-list / shell-history leak).
  const token =
    process.env['CANTON_TOKEN'] ??
    file.token ??
    undefined;

  const party =
    argv.party ??
    process.env['CANTON_PARTY'] ??
    file.party ??
    undefined;

  return {
    host,
    port,
    useTls,
    token,
    actAs: party ? [party] : [],
  };
}
