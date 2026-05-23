/**
 * Pending stream request queries.
 *
 * Lists CreateStreamRequest contracts visible to the caller so recipients
 * can review and accept them from the dashboard.
 *
 * @module commands/requests
 */

import type { Logger } from 'pino';
import type {
  PendingStreamRequest,
  PendingStreamRequestFilter,
  StreamConfig,
  InstrumentRef,
  VestingModeConfig,
  LedgerRecord,
} from '../types/stream.js';
import { AssetType, VestingMode, SettlementMode } from '../types/stream.js';
import type { Transport } from '../transport/base.js';
import { CREATE_REQUEST_TEMPLATES } from '../templates.js';
import Decimal from 'decimal.js';

export async function listPendingStreamRequests(
  transport: Transport,
  filter: PendingStreamRequestFilter | undefined,
  actAs: string[],
  readAs: string[] | undefined,
  logger: Logger,
): Promise<PendingStreamRequest[]> {
  logger.debug({ filter }, 'Listing pending stream requests (querying all template types)');

  // Query each create-request template separately and merge results.
  // Each result is tagged with its settlement mode from explicit template metadata.
  let requests: PendingStreamRequest[] = [];

  for (const { templateId, settlementMode } of CREATE_REQUEST_TEMPLATES) {
    try {
      const results = await transport.query<any>(
        templateId,
        undefined,
        actAs,
        readAs,
      );
      const templateRequests = results.map((raw: any) =>
        deserializePendingRequest(raw, settlementMode),
      );
      requests = requests.concat(templateRequests);
    } catch {
      // Template might not be deployed yet; skip silently
      continue;
    }
  }

  if (filter?.sender) {
    requests = requests.filter((request) => request.config.sender === filter.sender);
  }
  if (filter?.recipient) {
    requests = requests.filter((request) => request.config.recipient === filter.recipient);
  }
  if (filter?.assetType) {
    requests = requests.filter((request) => request.config.assetType === filter.assetType);
  }

  logger.debug({ count: requests.length }, 'Pending stream requests listed');
  return requests;
}

function deserializePendingRequest(raw: any, settlementMode: SettlementMode = SettlementMode.NumericLegacy): PendingStreamRequest {
  const recipientAccount =
    settlementMode === SettlementMode.TokenStandardCustody
      ? deserializeLedgerRecordFromText(raw.recipientAccountRef)
      : deserializeLedgerRecord(raw.recipientAccount);

  return {
    contractId: raw.contractId ?? raw.contract_id ?? '',
    config: {
      ...deserializeConfig(raw.config ?? raw),
      settlementMode,
    },
    recipientAccount,
    observers: Array.isArray(raw.observers) ? raw.observers : [],
    settlementMode,
    // Include custody-specific fields for non-numeric requests
    ...(settlementMode !== SettlementMode.NumericLegacy && {
      fundingHoldingCid: raw.fundingHoldingCid?.text ?? raw.fundingHoldingCid ?? undefined,
      fundingReference: raw.fundingReference?.text ?? raw.fundingReference ?? undefined,
      escrowOperator: raw.escrowOperator?.party ?? raw.escrowOperator ?? undefined,
    }),
  };
}

function deserializeConfig(raw: any): StreamConfig {
  return {
    streamId: raw.streamId,
    sender: raw.sender,
    recipient: raw.recipient,
    totalDeposited: new Decimal(raw.totalDeposited),
    startTime: deserializeTime(raw.startTime),
    endTime: deserializeTime(raw.endTime),
    vestingMode: deserializeVestingMode(raw.vestingMode),
    assetType: deserializeAssetType(raw.assetType),
    instrumentRef: deserializeInstrumentRef(raw.instrumentRef),
    cancellable: raw.cancellable ?? true,
  };
}

function deserializeTime(raw: any): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) {
      return new Date(Number(BigInt(raw) / 1000n));
    }
    return new Date(raw);
  }
  if (typeof raw === 'object' && raw !== null && 'seconds' in raw) {
    const seconds = typeof raw.seconds === 'string' ? BigInt(raw.seconds) : BigInt(raw.seconds);
    const nanos = raw.nanos ?? 0;
    return new Date(Number(seconds * 1000n) + Math.floor(nanos / 1_000_000));
  }
  if (typeof raw === 'number') return new Date(raw);
  return new Date(raw);
}

function deserializeVestingMode(raw: any): VestingModeConfig {
  if (!raw) return { mode: VestingMode.Linear };

  const tag = raw.tag ?? raw.variant_constructor ?? raw;
  const value = raw.value ?? {};

  switch (tag) {
    case 'Linear':
      return { mode: VestingMode.Linear };
    case 'CliffLinear':
      return {
        mode: VestingMode.CliffLinear,
        cliffTime: deserializeTime(value.cliffTime),
      };
    case 'Stepped':
      return {
        mode: VestingMode.Stepped,
        stepInterval: deserializeRelTime(value.stepInterval),
        amountPerStep: new Decimal(value.amountPerStep?.numeric ?? value.amountPerStep ?? '0'),
      };
    case 'RenewableTerm':
      return {
        mode: VestingMode.RenewableTerm,
        termDuration: deserializeRelTime(value.termDuration),
      };
    default:
      return { mode: VestingMode.Linear };
  }
}

function deserializeRelTime(raw: any): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  if (typeof raw === 'object' && raw !== null) {
    if ('microseconds' in raw) {
      return Number(raw.microseconds);
    }
    if ('int64' in raw) {
      return Number(raw.int64);
    }
  }
  return Number(raw ?? 0);
}

function deserializeAssetType(raw: any): AssetType {
  if (!raw) return AssetType.GlobalCip56;

  const tag = raw.tag ?? raw.variant_constructor ?? raw;
  switch (tag) {
    case 'ValidatorLocalAsset':
    case 'LocalToken':
      return AssetType.ValidatorLocalAsset;
    case 'LocalCip56':
    case 'LocalHolding':
      return AssetType.LocalCip56;
    case 'GlobalCip56':
    case 'GlobalHolding':
      return AssetType.GlobalCip56;
    default:
      return AssetType.GlobalCip56;
  }
}

function deserializeInstrumentRef(raw: any): InstrumentRef | undefined {
  if (!raw) return undefined;

  const tag = raw.tag ?? raw.variant_constructor;
  if (tag === 'None') return undefined;

  const value = tag === 'Some' ? (raw.value ?? raw) : raw;
  if (!value || !value.depository) return undefined;

  return {
    depository: value.depository,
    issuer: value.issuer,
    instrumentId: value.instrumentId,
    instrumentVersion: value.instrumentVersion,
  };
}

function deserializeLedgerRecord(raw: any): LedgerRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return raw as LedgerRecord;
}

function deserializeLedgerRecordFromText(raw: any): LedgerRecord | undefined {
  const text = raw?.text ?? raw;
  if (typeof text !== 'string' || !text.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LedgerRecord;
    }
  } catch {
    // Ignore invalid JSON and treat it as unavailable.
  }

  return undefined;
}
