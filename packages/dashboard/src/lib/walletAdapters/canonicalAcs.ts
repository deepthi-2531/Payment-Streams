/**
 * @module lib/walletAdapters/canonicalAcs
 *
 * Holdings reader for wallets whose CIP-0103 `ledgerApi` accepts
 * the canonical Canton v2 ACS query (Send, Nightly, Console).
 * These wallets proxy the request to the underlying participant
 * and return the raw response, so the dashboard can run a
 * filtered query for the CIP-56 V2 `Holding` interface and decode
 * the view payloads.
 *
 * Unlike the Loop adapter which has a wallet-side allowlist that
 * inspects the body for `filter.filtersByParty.<party>.inclusive
 * .templateFilters[0].templateId`, the generic ledgerApi
 * wallets pass through whatever body we send. We use the
 * canonical v2 shape with `cumulative` + `identifierFilter`.
 *
 * This module returns AcsHolding rows. The facade in
 * `lib/walletHoldings.ts` maps them onto the wallet-neutral
 * `WalletHolding` shape.
 *
 * Pre-conditions:
 *   - The wallet exposes `walletClient.ledgerApi`
 *     (`capabilities.ledgerApi === true`).
 *   - The Splice token-standard V2 DARs (`splice-api-token-*-v2`)
 *     are vetted on the participant the wallet is attached to.
 *
 * When the DARs aren't vetted, the query returns []. We don't
 * distinguish that from "user has zero holdings" at this layer;
 * the dashboard surfaces a neutral empty state.
 */

import { walletClient } from '../../store/wallet/index.js';

export interface AcsHolding {
  /** Contract id of the Holding instance. */
  readonly contractId: string;
  /** Instrument admin party (CIP-56 InstrumentId.admin). */
  readonly instrumentAdmin: string;
  /** Instrument id string (CIP-56 InstrumentId.id). */
  readonly instrumentId: string;
  /** Holding amount, decoded as a string-encoded big integer (minor units). */
  readonly amount: string;
  /** Display symbol if the wallet surfaced it; otherwise unset. */
  readonly symbol?: string;
  /** Display name if the wallet surfaced it; otherwise unset. */
  readonly issuerName?: string;
  /** Decimal places, if the wallet surfaced it (defaults to 0). */
  readonly decimals?: number;
}

/**
 * CIP-56 V2 Holding interface — `#package-name:Module:Entity`.
 * Querying by interface returns every Holding contract regardless
 * of the concrete admin/issuer package.
 */
const HOLDING_INTERFACE_ID =
  '#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding';

interface LedgerApiResponseWrapper {
  readonly response?: string;
}

interface AcsActiveContractsResponse {
  readonly activeContracts?: ReadonlyArray<AcsContractEntry>;
  readonly active_contracts?: ReadonlyArray<AcsContractEntry>;
}

interface AcsContractEntry {
  readonly created_event?: AcsCreatedEvent;
  readonly createdEvent?: AcsCreatedEvent;
}

interface AcsCreatedEvent {
  readonly contract_id?: string;
  readonly contractId?: string;
  readonly create_arguments?: Record<string, unknown>;
  readonly createArguments?: Record<string, unknown>;
  /** V2 Ledger API returns interface views keyed by interfaceId. */
  readonly interface_views?: ReadonlyArray<{
    readonly interface_id?: string;
    readonly interfaceId?: string;
    readonly view_value?: Record<string, unknown>;
    readonly viewValue?: Record<string, unknown>;
  }>;
  readonly interfaceViews?: ReadonlyArray<{
    readonly interface_id?: string;
    readonly interfaceId?: string;
    readonly view_value?: Record<string, unknown>;
    readonly viewValue?: Record<string, unknown>;
  }>;
}

/**
 * Query the participant for all Holdings owned by the active
 * party, via the wallet's `ledgerApi`. Returns [] if the DARs
 * aren't vetted, the participant can't fulfill the query, or
 * the wallet doesn't actually proxy through.
 */
export async function queryHoldingsViaLedgerApi(): Promise<readonly AcsHolding[]> {
  const wc = walletClient.ledgerApi;
  if (!wc) return [];
  const accounts = await walletClient.listAccounts();
  const party = accounts.find((a) => a.primary)?.partyId ?? accounts[0]?.partyId;
  if (!party) return [];
  const body = {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId: HOLDING_INTERFACE_ID,
                    includeInterfaceView: true,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: '0',
  };
  let raw: unknown;
  try {
    raw = await wc({
      requestMethod: 'post',
      resource: '/v2/state/acs',
      body: JSON.stringify(body),
    });
  } catch {
    // DAR not deployed / capability not implemented — empty is the
    // honest answer. The facade will return strategy='canonical-acs'
    // with [] holdings.
    return [];
  }
  const parsed = (() => {
    if (raw && typeof (raw as LedgerApiResponseWrapper).response === 'string') {
      try {
        return JSON.parse((raw as LedgerApiResponseWrapper).response!) as AcsActiveContractsResponse;
      } catch {
        return {} as AcsActiveContractsResponse;
      }
    }
    return (raw as AcsActiveContractsResponse) ?? {};
  })();

  const items = parsed.activeContracts ?? parsed.active_contracts ?? [];
  return items
    .map((entry): AcsHolding | null => {
      const ev = entry.created_event ?? entry.createdEvent;
      if (!ev) return null;
      const cid = ev.contract_id ?? ev.contractId;
      if (!cid) return null;
      const views = ev.interface_views ?? ev.interfaceViews ?? [];
      const holdingView = views.find(
        (v) => (v.interface_id ?? v.interfaceId ?? '').includes(':HoldingV2:'),
      );
      const view = holdingView?.view_value ?? holdingView?.viewValue;
      if (!view) return null;
      const instrument = (view.instrumentId ?? view.instrument_id ?? {}) as Record<
        string,
        unknown
      >;
      const admin = typeof instrument.admin === 'string' ? instrument.admin : '';
      const id = typeof instrument.id === 'string' ? instrument.id : '';
      const amount =
        typeof view.amount === 'string'
          ? view.amount
          : view.amount != null
            ? String(view.amount)
            : '0';
      if (!admin || !id) return null;
      return {
        contractId: cid,
        instrumentAdmin: admin,
        instrumentId: id,
        amount,
      };
    })
    .filter((h): h is AcsHolding => h !== null);
}
