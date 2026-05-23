type CheckStatus = 'ok' | 'error' | 'skipped';
type OverallStatus = 'ok' | 'degraded' | 'skipped';

export interface ReadinessCheck {
  readonly status: CheckStatus;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface ReadinessReport {
  readonly status: OverallStatus;
  readonly checkedAt: string;
  readonly jsonApiUrl: string | null;
  readonly checks: {
    packageEndpoint: ReadinessCheck;
    vettedPackages: ReadinessCheck;
    interactiveSubmission: ReadinessCheck;
  };
}

export interface ReadinessConfig {
  readonly jsonApiUrl?: string;
  readonly token?: string;
  readonly requiredPackageIds: string[];
  readonly requiredPackageNames: string[];
  readonly requirePackageEndpoint: boolean;
  readonly requireVettedPackages: boolean;
  readonly failOnUnknownPackageVetting: boolean;
  readonly requireInteractiveSubmissionEndpoint: boolean;
}

interface KnownPackage {
  id: string;
  name: string | null;
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly payload?: unknown;

  constructor(statusCode: number, message: string, payload?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

export function normalizePackageIdValue(value: unknown): string {
  return String(value ?? '').trim();
}

function uniquePackageIds(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizePackageIdValue).filter(Boolean))];
}

function extractPackageIdsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return uniquePackageIds([
    env['CANTON_STREAMS_PACKAGE_ID'] ?? '',
    env['CANTON_STREAMS_UTILITY_PACKAGE_ID'] ?? '',
    env['CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID'] ?? '',
    env['CANTON_STREAMS_LOCAL_ASSET_PACKAGE_ID'] ?? '',
    env['CANTON_STREAMS_POLICY_PACKAGE_ID'] ?? '',
  ]);
}

export function createReadinessConfig(
  env: NodeJS.ProcessEnv,
  defaultToken?: string,
): ReadinessConfig {
  const explicitPackageIds = parseCommaSeparatedList(env['PROXY_STARTUP_REQUIRED_PACKAGE_IDS']);
  const configuredPackageIds =
    explicitPackageIds.length > 0 ? explicitPackageIds : extractPackageIdsFromEnv(env);

  return {
    jsonApiUrl: String(env['CANTON_JSON_API_URL'] ?? '').trim() || undefined,
    token: String(env['CANTON_JSON_API_TOKEN'] ?? defaultToken ?? '').trim() || undefined,
    requiredPackageIds: configuredPackageIds,
    requiredPackageNames: parseCommaSeparatedList(env['PROXY_STARTUP_REQUIRED_PACKAGE_NAMES']),
    requirePackageEndpoint: parseBoolean(env['PROXY_STARTUP_REQUIRE_PACKAGE_ENDPOINT'], false),
    requireVettedPackages: parseBoolean(env['PROXY_STARTUP_REQUIRE_VETTED_PACKAGES'], false),
    failOnUnknownPackageVetting: parseBoolean(
      env['PROXY_STARTUP_FAIL_ON_UNKNOWN_PACKAGE_VETTING'],
      false,
    ),
    requireInteractiveSubmissionEndpoint: parseBoolean(
      env['PROXY_STARTUP_REQUIRE_INTERACTIVE_SUBMISSION_ENDPOINT'],
      false,
    ),
  };
}

export function extractPackageNameFromStatusPayload(statusPayload: unknown): string {
  const payload = asRecord(statusPayload);
  const candidates = [
    payload['packageName'],
    payload['name'],
    asRecord(payload['package'])['name'],
    asRecord(payload['result'])['packageName'],
    asRecord(payload['result'])['name'],
    asRecord(asRecord(payload['result'])['package'])['name'],
    asRecord(payload['packageStatus'])['packageName'],
    asRecord(payload['packageStatus'])['name'],
    asRecord(asRecord(payload['result'])['packageStatus'])['packageName'],
    asRecord(asRecord(payload['result'])['packageStatus'])['name'],
    asRecord(payload['packageReference'])['packageName'],
    asRecord(asRecord(payload['result'])['packageReference'])['packageName'],
    asRecord(payload['description'])['packageName'],
    asRecord(asRecord(payload['result'])['description'])['packageName'],
  ];

  for (const candidate of candidates) {
    const rendered = String(candidate ?? '').trim();
    if (rendered) {
      return rendered;
    }
  }

  return '';
}

export function extractPackageVettedState(statusPayload: unknown): boolean | null {
  const payload = asRecord(statusPayload);
  const explicitBooleanCandidates = [
    payload['vetted'],
    payload['isVetted'],
    payload['packageVetted'],
    asRecord(payload['result'])['vetted'],
    asRecord(payload['result'])['isVetted'],
    asRecord(payload['result'])['packageVetted'],
    asRecord(payload['packageStatus'])['vetted'],
    asRecord(payload['packageStatus'])['isVetted'],
    asRecord(asRecord(payload['result'])['packageStatus'])['vetted'],
    asRecord(asRecord(payload['result'])['packageStatus'])['isVetted'],
  ];

  for (const candidate of explicitBooleanCandidates) {
    if (typeof candidate === 'boolean') {
      return candidate;
    }
  }

  const explicitStatusCandidates = [
    payload['status'],
    payload['packageStatus'],
    asRecord(payload['result'])['status'],
    asRecord(payload['result'])['packageStatus'],
    asRecord(payload['packageStatus'])['status'],
    asRecord(asRecord(payload['result'])['packageStatus'])['status'],
    payload['packageState'],
    asRecord(payload['result'])['packageState'],
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);

  for (const status of explicitStatusCandidates) {
    if (status.includes('not_vetted') || status.includes('not vetted') || status.includes('unvetted')) {
      return false;
    }

    if (status.includes('vetted')) {
      return true;
    }

    if (
      status.includes('registered') ||
      status.includes('unknown') ||
      status.includes('unregistered')
    ) {
      return false;
    }
  }

  const discoveredTokens = new Set<string>();
  const queue: unknown[] = [statusPayload];
  let guard = 0;

  while (queue.length > 0 && guard < 500) {
    guard += 1;
    const value = queue.shift();
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized) {
        discoveredTokens.add(normalized);
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        queue.push(item);
      }
      continue;
    }

    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        const normalizedKey = String(key ?? '').trim().toLowerCase();
        if (normalizedKey) {
          discoveredTokens.add(normalizedKey);
        }
        queue.push(nested);
      }
    }
  }

  for (const token of discoveredTokens) {
    if (token.includes('not_vetted') || token.includes('not vetted') || token.includes('unvetted')) {
      return false;
    }
  }

  for (const token of discoveredTokens) {
    if (token.includes('vetted')) {
      return true;
    }
  }

  return null;
}

export async function runStartupReadinessChecks(
  config: ReadinessConfig,
): Promise<ReadinessReport> {
  const checkedAt = new Date().toISOString();
  const report: ReadinessReport = {
    status: 'skipped',
    checkedAt,
    jsonApiUrl: config.jsonApiUrl ?? null,
    checks: {
      packageEndpoint: skippedCheck('Package endpoint check not required.'),
      vettedPackages: skippedCheck('Package vetting check not required.'),
      interactiveSubmission: skippedCheck('Interactive submission check not required.'),
    },
  };

  const anyChecksEnabled =
    config.requirePackageEndpoint ||
    config.requireVettedPackages ||
    config.requireInteractiveSubmissionEndpoint;

  if (!anyChecksEnabled) {
    return report;
  }

  if (!config.jsonApiUrl) {
    const missingJsonApi = errorCheck(
      'CANTON_JSON_API_URL must be configured when proxy startup readiness checks are enabled.',
    );

    if (config.requirePackageEndpoint) {
      report.checks.packageEndpoint = missingJsonApi;
    }
    if (config.requireVettedPackages) {
      report.checks.vettedPackages = missingJsonApi;
    }
    if (config.requireInteractiveSubmissionEndpoint) {
      report.checks.interactiveSubmission = missingJsonApi;
    }

    return withOverallStatus(report);
  }

  let knownPackages: KnownPackage[] | undefined;

  if (config.requirePackageEndpoint || config.requireVettedPackages) {
    const requiredPackageIds = uniquePackageIds(config.requiredPackageIds);
    const requiredPackageNames = [...new Set(config.requiredPackageNames.map((value) => value.trim()).filter(Boolean))];

    if (requiredPackageIds.length === 0 && requiredPackageNames.length === 0) {
      const missingRequirements = errorCheck(
        'No required streams package IDs or package names are configured for startup readiness checks.',
      );
      if (config.requirePackageEndpoint) {
        report.checks.packageEndpoint = missingRequirements;
      }
      if (config.requireVettedPackages) {
        report.checks.vettedPackages = missingRequirements;
      }
    } else {
      try {
        knownPackages = await listKnownPackages(config.jsonApiUrl, config.token);

        if (config.requirePackageEndpoint) {
          const packageEndpointResult = buildPackageEndpointCheck(
            knownPackages,
            requiredPackageIds,
            requiredPackageNames,
          );
          report.checks.packageEndpoint = packageEndpointResult;
        }

        if (config.requireVettedPackages) {
          const vettedPackagesResult = await buildPackageVettingCheck(
            config,
            knownPackages,
            requiredPackageIds,
            requiredPackageNames,
          );
          report.checks.vettedPackages = vettedPackagesResult;
        }
      } catch (error) {
        const message = formatErrorMessage(error);
        if (config.requirePackageEndpoint) {
          report.checks.packageEndpoint = errorCheck(message);
        }
        if (config.requireVettedPackages) {
          report.checks.vettedPackages = errorCheck(message);
        }
      }
    }
  }

  if (config.requireInteractiveSubmissionEndpoint) {
    try {
      const status = await probeInteractiveSubmission(config.jsonApiUrl, config.token);
      report.checks.interactiveSubmission = okCheck(
        `Interactive submission endpoint is reachable (HTTP ${status}).`,
        { httpStatus: status },
      );
    } catch (error) {
      report.checks.interactiveSubmission = errorCheck(formatErrorMessage(error));
    }
  }

  return withOverallStatus(report);
}

function buildPackageEndpointCheck(
  knownPackages: KnownPackage[],
  requiredPackageIds: string[],
  requiredPackageNames: string[],
): ReadinessCheck {
  const knownIdSet = new Set(knownPackages.map((entry) => normalizePackageIdValue(entry.id)));
  const missingIds = requiredPackageIds.filter((packageId) => !knownIdSet.has(normalizePackageIdValue(packageId)));

  const knownNameSet = new Set(
    knownPackages.map((entry) => String(entry.name ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const missingNames = requiredPackageNames.filter(
    (packageName) => !knownNameSet.has(packageName.trim().toLowerCase()),
  );

  if (missingIds.length > 0 || missingNames.length > 0) {
    return errorCheck(
      [
        missingIds.length > 0 ? `Missing package IDs: ${missingIds.join(', ')}.` : '',
        missingNames.length > 0 ? `Missing package names: ${missingNames.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      {
        missingPackageIds: missingIds,
        missingPackageNames: missingNames,
        knownPackageCount: knownPackages.length,
      },
    );
  }

  return okCheck('Required packages are visible on the JSON API participant.', {
    requiredPackageIds,
    requiredPackageNames,
    knownPackageCount: knownPackages.length,
  });
}

async function buildPackageVettingCheck(
  config: ReadinessConfig,
  knownPackages: KnownPackage[],
  requiredPackageIds: string[],
  requiredPackageNames: string[],
): Promise<ReadinessCheck> {
  const resolvedIdsFromNames: string[] = [];
  const missingRequiredNames: string[] = [];
  const namedPackages = knownPackages.filter((entry) => String(entry.name ?? '').trim());

  for (const packageName of requiredPackageNames) {
    const matchingIds = namedPackages
      .filter((entry) => String(entry.name ?? '').trim().toLowerCase() === packageName.trim().toLowerCase())
      .map((entry) => normalizePackageIdValue(entry.id))
      .filter(Boolean);

    if (matchingIds.length === 0) {
      missingRequiredNames.push(packageName);
      continue;
    }

    resolvedIdsFromNames.push(...matchingIds);
  }

  if (missingRequiredNames.length > 0) {
    return errorCheck(
      `Required package names are missing on the JSON API participant: ${missingRequiredNames.join(', ')}.`,
      { missingPackageNames: missingRequiredNames },
    );
  }

  const uniqueRequiredIds = uniquePackageIds([...requiredPackageIds, ...resolvedIdsFromNames]);
  const vetted: string[] = [];
  const nonVetted: string[] = [];
  const unknown: string[] = [];

  for (const packageId of uniqueRequiredIds) {
    const statusPayload = await loadPackageStatus(config.jsonApiUrl!, config.token, packageId);
    const vettedState = extractPackageVettedState(statusPayload);
    if (vettedState === true) {
      vetted.push(packageId);
    } else if (vettedState === false) {
      nonVetted.push(packageId);
    } else {
      unknown.push(packageId);
    }
  }

  if (nonVetted.length > 0) {
    return errorCheck(
      `Required package IDs are present but not vetted: ${nonVetted.join(', ')}.`,
      {
        nonVetted,
        vetted,
        unknown,
      },
    );
  }

  if (config.failOnUnknownPackageVetting && unknown.length > 0) {
    return errorCheck(
      `Could not determine vetting status for required package IDs: ${unknown.join(', ')}.`,
      {
        vetted,
        unknown,
      },
    );
  }

  return okCheck('Required packages are vetted for submission.', {
    vetted,
    unknown,
    checked: uniqueRequiredIds.length,
  });
}

async function listKnownPackages(baseUrl: string, token?: string): Promise<KnownPackage[]> {
  const response = await requestJson<{ packages?: unknown[]; result?: { packages?: unknown[] } | unknown[] }>(
    `${baseUrl.replace(/\/+$/, '')}/v2/packages`,
    token,
    { method: 'GET' },
  );

  const rows = Array.isArray(response?.packages)
    ? response.packages
    : Array.isArray(asRecord(response?.result)['packages'])
      ? (asRecord(response?.result)['packages'] as unknown[])
      : Array.isArray(response?.result)
        ? response.result
        : [];

  const packages: KnownPackage[] = [];
  for (const row of rows) {
    const payload = asRecord(row);
    const packageId = String(
      payload['packageId'] ??
      payload['package_id'] ??
      payload['package_id_hash'] ??
      payload['package'] ??
      payload['id'] ??
      '',
    ).trim();

    if (!packageId || packages.some((entry) => entry.id === packageId)) {
      continue;
    }

    const packageName = String(
      payload['packageName'] ??
      payload['package_name'] ??
      payload['name'] ??
      asRecord(payload['packageReference'])['packageName'] ??
      asRecord(payload['description'])['packageName'] ??
      '',
    ).trim();

    packages.push({
      id: packageId,
      name: packageName || null,
    });
  }

  for (const entry of packages.filter((item) => !item.name)) {
    try {
      const statusPayload = await loadPackageStatus(baseUrl, token, entry.id);
      const resolvedName = extractPackageNameFromStatusPayload(statusPayload);
      if (resolvedName) {
        entry.name = resolvedName;
      }
    } catch {
      // Best effort only.
    }
  }

  return packages;
}

async function loadPackageStatus(baseUrl: string, token: string | undefined, packageId: string): Promise<unknown> {
  const encoded = encodeURIComponent(packageId.trim());
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const endpoint = `${normalizedBaseUrl}/v2/packages/${encoded}/status`;

  try {
    return await requestJson(endpoint, token, { method: 'GET' });
  } catch (error) {
    if (parseEndpointProbeStatus(error) !== 405) {
      throw error;
    }

    return requestJson(endpoint, token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }
}

async function probeInteractiveSubmission(baseUrl: string, token?: string): Promise<number> {
  try {
    await requestJson(`${baseUrl.replace(/\/+$/, '')}/v2/interactive-submission/prepare`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return 200;
  } catch (error) {
    const status = parseEndpointProbeStatus(error);
    if ([400, 401, 403, 405, 409, 412].includes(status)) {
      return status;
    }
    throw error;
  }
}

export function parseEndpointProbeStatus(error: unknown): number {
  if (error instanceof HttpError) {
    return error.statusCode;
  }

  const message = formatErrorMessage(error);
  const match = message.match(/\b(\d{3})\b/);
  return match?.[1] ? parseInt(match[1], 10) : 0;
}

async function requestJson<T>(
  url: string,
  token: string | undefined,
  init: RequestInit,
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const text = await response.text();
  const payload = parseJsonSafely(text);

  if (!response.ok) {
    throw new HttpError(response.status, `${init.method ?? 'GET'} ${url} failed with HTTP ${response.status}`, payload ?? text);
  }

  return (payload ?? {}) as T;
}

function parseJsonSafely(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function skippedCheck(message: string): ReadinessCheck {
  return { status: 'skipped', message };
}

function okCheck(message: string, details?: Record<string, unknown>): ReadinessCheck {
  return { status: 'ok', message, details };
}

function errorCheck(message: string, details?: Record<string, unknown>): ReadinessCheck {
  return { status: 'error', message, details };
}

function withOverallStatus(report: ReadinessReport): ReadinessReport {
  const statuses = Object.values(report.checks).map((check) => check.status);
  if (statuses.includes('error')) {
    return { ...report, status: 'degraded' };
  }
  if (statuses.every((status) => status === 'skipped')) {
    return { ...report, status: 'skipped' };
  }
  return { ...report, status: 'ok' };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    const payload = error.payload;
    const renderedPayload =
      typeof payload === 'string'
        ? payload.trim()
        : payload !== undefined
          ? JSON.stringify(payload)
          : '';
    return renderedPayload
      ? `${error.message}: ${renderedPayload}`
      : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
