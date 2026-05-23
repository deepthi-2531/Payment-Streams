import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_LOCAL_CONFIG_PATH = path.join(ROOT_DIR, "config", "local.testnet.json");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadLocalScriptConfig(sectionName) {
  const configuredPath = String(process.env["CANTON_STREAMS_LOCAL_CONFIG"] ?? "").trim();
  const configPath = configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : DEFAULT_LOCAL_CONFIG_PATH;

  if (!existsSync(configPath)) {
    return { configPath, values: {} };
  }

  const raw = readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in local config ${configPath}: ${detail}`);
  }

  const defaults = isRecord(parsed?.defaults) ? parsed.defaults : {};
  const scripts = isRecord(parsed?.scripts) ? parsed.scripts : {};
  const section = sectionName && isRecord(scripts[sectionName]) ? scripts[sectionName] : {};

  return {
    configPath,
    values: {
      ...defaults,
      ...section,
    },
  };
}
