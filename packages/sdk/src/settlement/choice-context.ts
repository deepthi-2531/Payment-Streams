/**
 * @module settlement/choice-context
 *
 * Registry choice-context fetcher for the transitional CIP-56 V1 lane.
 *
 * Registries whose token implementations depend on off-ledger or
 * shared-contract state (notably Amulet: AmuletRules, OpenMiningRound)
 * publish a token-standard HTTP API that returns, per choice exercise:
 *
 *   - `choiceContextData` — opaque context values the choice argument's
 *     `extraArgs.context` must carry, and
 *   - `disclosedContracts` — contracts the submitter must disclose with
 *     the command (the submitter is not a stakeholder of them).
 *
 * Endpoints used (per `splice-api-token-allocation-v1` /
 * `splice-api-token-allocation-instruction-v1` OpenAPI):
 *
 *   POST {base}/registry/allocations/v1/{allocationId}/choice-contexts/execute-transfer
 *   POST {base}/registry/allocations/v1/{allocationId}/choice-contexts/cancel
 *   POST {base}/registry/allocations/v1/{allocationId}/choice-contexts/withdraw
 *   POST {base}/registry/allocation-instruction/v1/allocation-factory
 *
 * For Amulet the API is served by Scan; use the asset's
 * `tokenStandardApiUrl` (falling back to `scanEndpointUrl`) as `base`.
 *
 * Browser-safe: uses `fetch`, no Node-only dependencies.
 *
 * @deprecated from birth together with the V1 lane — delete with
 * `commands/allocation-v1.ts` (see "V1 lane retirement" in CHANGELOG).
 */

import type { DisclosedContract } from '../transport/base.js';
import type { ChoiceContextV1 } from '../commands/allocation-v1.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** V1 allocation choices that take a registry choice context. */
export type AllocationChoiceContextAction = 'execute-transfer' | 'cancel' | 'withdraw';

export interface FetchChoiceContextParams {
  /**
   * Token-standard registry API base URL (for Amulet: the Scan base).
   * Trailing slash is tolerated.
   */
  readonly registryApiUrl: string;
  /** Allocation contract id the choice will be exercised on. */
  readonly allocationId: string;
  /** Which choice the context is for. */
  readonly action: AllocationChoiceContextAction;
  /** Optional bearer token (registries may require auth). */
  readonly token?: string;
  /** Extra headers (e.g. tenant routing). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional metadata forwarded in the request body. */
  readonly meta?: Readonly<Record<string, string>>;
}

export interface AllocationFactoryRequest {
  /**
   * The `AllocationFactory_Allocate` choice arguments as DA-JSON, per
   * the registry's allocation-instruction OpenAPI (`choiceArguments`).
   */
  readonly choiceArguments: Readonly<Record<string, unknown>>;
  readonly excludeDebugFields?: boolean;
}

export interface AllocationFactoryResult {
  /** Contract id of the registry's AllocationFactory to exercise. */
  readonly factoryId: string;
  /** Context + disclosures for the `AllocationFactory_Allocate` exercise. */
  readonly choiceContext: ChoiceContextV1;
}

// ---------------------------------------------------------------------------
// Wire-shape mapping
// ---------------------------------------------------------------------------

interface WireDisclosedContract {
  readonly templateId?: string;
  readonly template_id?: string;
  readonly contractId?: string;
  readonly contract_id?: string;
  readonly createdEventBlob?: string;
  readonly created_event_blob?: string;
  readonly synchronizerId?: string;
  readonly synchronizer_id?: string;
}

function mapDisclosedContract(wire: WireDisclosedContract): DisclosedContract {
  const templateId = wire.templateId ?? wire.template_id;
  const contractId = wire.contractId ?? wire.contract_id;
  const createdEventBlob = wire.createdEventBlob ?? wire.created_event_blob;
  if (!templateId || !contractId || !createdEventBlob) {
    throw new Error(
      'Registry returned a disclosed contract missing templateId/contractId/createdEventBlob',
    );
  }
  const synchronizerId = wire.synchronizerId ?? wire.synchronizer_id;
  return {
    templateId,
    contractId,
    createdEventBlob,
    ...(synchronizerId !== undefined ? { synchronizerId } : {}),
  };
}

/**
 * Map a registry `ChoiceContext` body to {@link ChoiceContextV1}.
 *
 * `choiceContextData` is the DA-JSON encoding of
 * `ChoiceContext { values : TextMap AnyValue }`. Some registries encode
 * the wrapper (`{ values: {...} }`), some return the values map
 * directly — accept both.
 */
function mapChoiceContext(body: Record<string, unknown>): ChoiceContextV1 {
  const data = (body['choiceContextData'] ?? body['choice_context_data'] ?? {}) as
    Record<string, unknown>;
  const values = (
    typeof data['values'] === 'object' && data['values'] !== null
      ? data['values']
      : data
  ) as Record<string, unknown>;
  const wireDisclosed = (body['disclosedContracts'] ?? body['disclosed_contracts'] ?? []) as
    WireDisclosedContract[];
  return {
    values,
    disclosedContracts: wireDisclosed.map(mapDisclosedContract),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body: unknown,
  token?: string,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Never follow redirects on an authenticated call (the default
  // re-sends the Authorization header to the 3xx target — token exfil to
  // an attacker host), and bound the request with a timeout.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      redirect: 'error',
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = await response.text();
    }
    throw new RegistryApiError(
      response.status,
      `Registry API ${url} failed (${response.status}): ${detail}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Error from the token-standard registry API. */
export class RegistryApiError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'RegistryApiError';
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Fetch the registry choice context for a V1 allocation choice.
 *
 * The returned {@link ChoiceContextV1} plugs straight into the V1
 * builders / `dispatchSettlementV1` commands: context values are encoded
 * into `extraArgs.context`, disclosed contracts ride the command.
 */
export async function fetchAllocationChoiceContext(
  params: FetchChoiceContextParams,
): Promise<ChoiceContextV1> {
  const base = params.registryApiUrl.replace(/\/$/, '');
  const url =
    `${base}/registry/allocations/v1/${encodeURIComponent(params.allocationId)}` +
    `/choice-contexts/${params.action}`;
  const body = params.meta !== undefined ? { meta: params.meta } : {};
  const response = await postJson(url, body, params.token, params.headers);
  // Some registries nest the context under `choiceContext`.
  const contextBody = (response['choiceContext'] ?? response) as Record<string, unknown>;
  return mapChoiceContext(contextBody);
}

/**
 * Resolve the registry's `AllocationFactory` for creating a V1
 * Allocation (used by senders without a wallet UI — e.g. probe scripts
 * and service-side flows). Returns the factory contract id plus the
 * choice context + disclosures for `AllocationFactory_Allocate`.
 */
export async function fetchAllocationFactory(
  registryApiUrl: string,
  request: AllocationFactoryRequest,
  opts?: { readonly token?: string; readonly headers?: Readonly<Record<string, string>> },
): Promise<AllocationFactoryResult> {
  const base = registryApiUrl.replace(/\/$/, '');
  const url = `${base}/registry/allocation-instruction/v1/allocation-factory`;
  const response = await postJson(
    url,
    {
      choiceArguments: request.choiceArguments,
      excludeDebugFields: request.excludeDebugFields ?? true,
    },
    opts?.token,
    opts?.headers,
  );
  const factoryId = (response['factoryId'] ?? response['factory_id']) as string | undefined;
  if (!factoryId) {
    throw new Error('Registry allocation-factory response missing factoryId');
  }
  const contextBody = (response['choiceContext'] ?? response['choice_context'] ?? {}) as
    Record<string, unknown>;
  return {
    factoryId,
    choiceContext: mapChoiceContext(contextBody),
  };
}
