import { loadLocalScriptConfig } from "../../scripts/local-config.mjs";

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function requireConfig(name, value) {
  if (!value) {
    throw new Error(`Missing required value for ${name}. Set the env var or provide it in config/local.testnet.json.`);
  }
  return value;
}

const localConfig = loadLocalScriptConfig("sdkDebug").values;
const parties = asRecord(localConfig.parties);
const packages = asRecord(localConfig.packages);
const contracts = asRecord(localConfig.contracts);
const auth0 = asRecord(localConfig.auth0);

export const SDK_DEBUG = {
  host: env("SDK_DEBUG_HOST", String(localConfig.host ?? "localhost")),
  port: Number(env("SDK_DEBUG_PORT", String(localConfig.port ?? "5001"))),
  token: env("PROXY_DEFAULT_TOKEN"),
  parties: {
    streamsUser: env("SDK_DEBUG_STREAMS_USER_PARTY", String(parties.streamsUser ?? "")),
    dnva: env("SDK_DEBUG_DNVA_PARTY", String(parties.dnva ?? "")),
    dflx: env("SDK_DEBUG_DFLX_PARTY", String(parties.dflx ?? "")),
    primary: env("SDK_DEBUG_PRIMARY_PARTY", String(parties.primary ?? "")),
    cbtcNetwork: env("SDK_DEBUG_CBTC_NETWORK_PARTY", String(parties.cbtcNetwork ?? "")),
    cbtcAdmin: env("SDK_DEBUG_CBTC_ADMIN_PARTY", String(parties.cbtcAdmin ?? "")),
  },
  packages: {
    utilityRegistryApp: env(
      "SDK_DEBUG_UTILITY_REGISTRY_APP_PACKAGE_ID",
      String(packages.utilityRegistryApp ?? ""),
    ),
    utilityRegistryHolding: env(
      "SDK_DEBUG_UTILITY_REGISTRY_HOLDING_PACKAGE_ID",
      String(packages.utilityRegistryHolding ?? ""),
    ),
  },
  contracts: {
    cbtcOffer1: env("SDK_DEBUG_CBTC_OFFER_1", String(contracts.cbtcOffer1 ?? "")),
    cbtcOffer2: env("SDK_DEBUG_CBTC_OFFER_2", String(contracts.cbtcOffer2 ?? "")),
    cbtcOffer3: env("SDK_DEBUG_CBTC_OFFER_3", String(contracts.cbtcOffer3 ?? "")),
    acceptTransfer: env(
      "SDK_DEBUG_ACCEPT_TRANSFER_CONTRACT_ID",
      String(contracts.acceptTransfer ?? ""),
    ),
  },
  auth0: {
    tokenUrl: env("SDK_DEBUG_AUTH0_TOKEN_URL", String(auth0.tokenUrl ?? "")),
    clientId: env("SDK_DEBUG_AUTH0_CLIENT_ID", String(auth0.clientId ?? "")),
    clientSecret: env("SDK_DEBUG_AUTH0_CLIENT_SECRET", String(auth0.clientSecret ?? "")),
    audience: env("SDK_DEBUG_AUTH0_AUDIENCE", String(auth0.audience ?? "")),
  },
};

export function transportConfig(token, actAs = [], readAs = []) {
  return {
    host: SDK_DEBUG.host,
    port: SDK_DEBUG.port,
    useTls: false,
    token,
    actAs,
    ...(readAs.length > 0 ? { readAs } : {}),
  };
}

export async function fetchAuth0AccessToken() {
  const tokenUrl = requireConfig("SDK_DEBUG_AUTH0_TOKEN_URL", SDK_DEBUG.auth0.tokenUrl);
  const clientId = requireConfig("SDK_DEBUG_AUTH0_CLIENT_ID", SDK_DEBUG.auth0.clientId);
  const clientSecret = requireConfig("SDK_DEBUG_AUTH0_CLIENT_SECRET", SDK_DEBUG.auth0.clientSecret);
  const audience = requireConfig("SDK_DEBUG_AUTH0_AUDIENCE", SDK_DEBUG.auth0.audience);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      grant_type: "client_credentials",
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(`Auth0 token request failed: ${JSON.stringify(payload)}`);
  }

  return String(payload.access_token);
}
