#!/usr/bin/env node

const USAGE = `Usage:
  CANTON_ADMIN_TOKEN=<jwt> \\
  node scripts/provision-streams-service.mjs \\
    --api-url http://host:7575 \\
    --user-id streams-service-testnet \\
    [--primary-party <party>] \\
    [--identity-provider-id <id>] \\
    [--grant-read-as-any-party] \\
    [--act-as <party>]... \\
    [--read-as <party>]... \\
    [--json]

Environment fallbacks:
  CANTON_JSON_API_URL
  CANTON_ADMIN_TOKEN
  STREAMS_SERVICE_USER_ID
  STREAMS_SERVICE_PRIMARY_PARTY
  CANTON_IDENTITY_PROVIDER_ID
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {
    apiUrl: process.env.CANTON_JSON_API_URL || "",
    adminToken: process.env.CANTON_ADMIN_TOKEN || "",
    userId: process.env.STREAMS_SERVICE_USER_ID || "",
    primaryParty: process.env.STREAMS_SERVICE_PRIMARY_PARTY || "",
    identityProviderId: process.env.CANTON_IDENTITY_PROVIDER_ID || "",
    grantReadAsAnyParty: false,
    actAs: [],
    readAs: [],
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--api-url":
        result.apiUrl = argv[++i] || "";
        break;
      case "--admin-token":
        // A JWT on the command line leaks via `ps` and shell
        // history. Refuse the flag; require the CANTON_ADMIN_TOKEN env var.
        fail(
          "--admin-token is no longer accepted: a JWT passed as a CLI " +
            "argument is visible in the process list and shell history. " +
            "Pass it via the CANTON_ADMIN_TOKEN environment variable instead.",
        );
        break;
      case "--user-id":
        result.userId = argv[++i] || "";
        break;
      case "--primary-party":
        result.primaryParty = argv[++i] || "";
        break;
      case "--identity-provider-id":
        result.identityProviderId = argv[++i] || "";
        break;
      case "--grant-read-as-any-party":
        result.grantReadAsAnyParty = true;
        break;
      case "--act-as":
        result.actAs.push(argv[++i] || "");
        break;
      case "--read-as":
        result.readAs.push(argv[++i] || "");
        break;
      case "--json":
        result.json = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  result.apiUrl = String(result.apiUrl || "").trim().replace(/\/+$/, "");
  result.adminToken = String(result.adminToken || "").trim();
  result.userId = String(result.userId || "").trim();
  result.primaryParty = String(result.primaryParty || "").trim();
  result.identityProviderId = String(result.identityProviderId || "").trim();
  result.actAs = [...new Set(result.actAs.map((value) => String(value || "").trim()).filter(Boolean))];
  result.readAs = [...new Set(result.readAs.map((value) => String(value || "").trim()).filter(Boolean))];

  if (!result.apiUrl) fail(`Missing --api-url\n\n${USAGE}`);
  if (!result.adminToken) fail(`Missing --admin-token\n\n${USAGE}`);
  if (!result.userId) fail(`Missing --user-id\n\n${USAGE}`);

  return result;
}

async function requestJson(baseUrl, token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const error = new Error(
      `HTTP ${response.status} ${method} ${path}: ${
        typeof payload === "string" ? payload : JSON.stringify(payload)
      }`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function isAlreadyPresentError(error) {
  const message = String(error?.message || "").toLowerCase();
  return Number(error?.status || 0) === 409 || message.includes("already") || message.includes("duplicate");
}

function buildCreateUserPayloads(userId, primaryParty, identityProviderId) {
  return [
    {
      user: {
        id: userId,
        isDeactivated: false,
        identityProviderId,
        ...(primaryParty ? { primaryParty } : {}),
      },
    },
    {
      user: {
        id: userId,
        isDeactivated: false,
        identityProviderId,
      },
    },
    {
      id: userId,
      isDeactivated: false,
      identityProviderId,
      ...(primaryParty ? { primaryParty } : {}),
    },
    {
      userId: userId,
      identityProviderId,
      ...(primaryParty ? { primaryParty } : {}),
    },
    {
      user: {
        id: userId,
        isDeactivated: false,
        ...(primaryParty ? { primaryParty } : {}),
      },
      identityProviderId,
    },
  ];
}

async function ensureUserExists(config) {
  try {
    const existing = await requestJson(
      config.apiUrl,
      config.adminToken,
      `/v2/users/${encodeURIComponent(config.userId)}`,
    );
    return {
      created: false,
      alreadyPresent: true,
      user: existing.user || existing,
    };
  } catch (error) {
    if (Number(error?.status || 0) !== 404) {
      throw error;
    }
  }

  const payloads = buildCreateUserPayloads(
    config.userId,
    config.primaryParty,
    config.identityProviderId,
  );

  let lastError = null;
  for (const payload of payloads) {
    try {
      await requestJson(config.apiUrl, config.adminToken, "/v2/users", {
        method: "POST",
        body: payload,
      });
      const created = await requestJson(
        config.apiUrl,
        config.adminToken,
        `/v2/users/${encodeURIComponent(config.userId)}`,
      );
      return {
        created: true,
        alreadyPresent: false,
        user: created.user || created,
      };
    } catch (error) {
      if (isAlreadyPresentError(error)) {
        const existing = await requestJson(
          config.apiUrl,
          config.adminToken,
          `/v2/users/${encodeURIComponent(config.userId)}`,
        );
        return {
          created: false,
          alreadyPresent: true,
          user: existing.user || existing,
        };
      }
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to create user ${config.userId}`);
}

async function grantRights(config, rights) {
  if (rights.length === 0) {
    return { granted: false, alreadyPresent: false };
  }

  const endpoint = `/v2/users/${encodeURIComponent(config.userId)}/rights`;
  const payloads = [
    {
      userId: config.userId,
      identityProviderId: config.identityProviderId,
      rights,
    },
    {
      userId: config.userId,
      identityProviderId: config.identityProviderId,
      rights: rights.map((right) => ({ kind: right })),
    },
  ];

  let lastError = null;
  for (const payload of payloads) {
    try {
      await requestJson(config.apiUrl, config.adminToken, endpoint, {
        method: "POST",
        body: payload,
      });
      return { granted: true, alreadyPresent: false };
    } catch (error) {
      if (isAlreadyPresentError(error)) {
        return { granted: false, alreadyPresent: true };
      }
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to grant rights for ${config.userId}`);
}

function renderSummary(summary, asJson) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`service user: ${summary.user.id}`);
  console.log(`primary party: ${summary.user.primaryParty || "(none)"}`);
  console.log(`user created: ${summary.userCreated}`);
  console.log(`read-as-any-party granted: ${summary.readAsAnyPartyGranted}`);
  if (summary.actAs.length > 0) {
    console.log(`actAs granted: ${summary.actAs.join(", ")}`);
  }
  if (summary.readAs.length > 0) {
    console.log(`readAs granted: ${summary.readAs.join(", ")}`);
  }
}

async function main() {
  const config = parseArgs(process.argv);

  const userStatus = await ensureUserExists(config);

  const summary = {
    userCreated: userStatus.created,
    user: userStatus.user,
    readAsAnyPartyGranted: false,
    actAs: [],
    readAs: [],
  };

  if (config.grantReadAsAnyParty) {
    const granted = await grantRights(config, [{ CanReadAsAnyParty: { value: {} } }]);
    summary.readAsAnyPartyGranted = granted.granted || granted.alreadyPresent;
  }

  for (const party of config.actAs) {
    const granted = await grantRights(config, [{ CanActAs: { value: { party } } }]);
    if (granted.granted || granted.alreadyPresent) {
      summary.actAs.push(party);
    }
  }

  for (const party of config.readAs) {
    const granted = await grantRights(config, [{ CanReadAs: { value: { party } } }]);
    if (granted.granted || granted.alreadyPresent) {
      summary.readAs.push(party);
    }
  }

  renderSummary(summary, config.json);
}

main().catch((error) => {
  fail(error?.message || String(error));
});
