/**
 * Stream creation commands.
 *
 * V2-only stream creation.
 *
 * New streams use `StreamAdmin` for observability and CIP-56 V2
 * allocations for custody. Legacy settlement modes remain parseable in
 * public types for old deployments, but this command rejects them.
 *
 * @module commands/create
 */

import type { Transport } from '../transport/base.js';
import type { CreateStreamParams, CreateBatchParams, VestingModeConfig } from '../types/stream.js';
import { VestingMode, SettlementMode } from '../types/stream.js';
import { CreateStreamParamsSchema, validate } from '../utils/validation.js';
import {
  buildStreamAdminCreate,
  type VestingMode as StreamAdminVestingMode,
} from './stream-admin.js';
import { TEMPLATE_STREAM_ADMIN } from '../templates.js';
import type { Logger } from 'pino';

/**
 * Create a single payment stream.
 *
 * 1. Validates input params
 * 2. Generates streamId if not provided
 * 3. Creates a V2 StreamAdmin observability contract on-ledger
 * 4. Returns the created admin contract id
 *
 * Funding is intentionally wallet-driven: callers first obtain or prepare
 * the V2 allocation through the Amulet wallet, then create StreamAdmin
 * metadata that references the CIP-56 V2 instrument and funding reference.
 */
export async function createStream(
  transport: Transport,
  params: CreateStreamParams,
  actAs: string[],
  logger: Logger,
): Promise<{ requestContractId: string; streamId: string }> {
  // Zod's record inference returns Record<string, unknown>; cast to our stricter type.
  const validated = validate(CreateStreamParamsSchema, params) as unknown as CreateStreamParams;
  const streamId = validated.streamId || generateStreamId();

  assertActAsIncludesSender(actAs, validated.sender);

  const settlementMode = validated.settlementMode ?? SettlementMode.TokenStandardCustody;
  logger.info(
    { streamId, recipient: validated.recipient, settlementMode },
    'Creating stream request',
  );

  if (settlementMode !== SettlementMode.TokenStandardCustody) {
    throw new Error(
      `Unsupported settlementMode for new streams: ${settlementMode}. ` +
        'This SDK is V2-only; use TokenStandardCustody.',
    );
  }

  if (!validated.fundingReference)
    throw new Error('fundingReference required for TokenStandardCustody');
  if (!validated.instrumentRef) throw new Error('instrumentRef required for TokenStandardCustody');
  if (!validated.escrowOperator)
    throw new Error('escrowOperator required for TokenStandardCustody');
  if (!validated.senderAccount) throw new Error('senderAccount required for TokenStandardCustody');
  if (!validated.recipientAccount)
    throw new Error('recipientAccount required for TokenStandardCustody');

  await assertNoDuplicateStreamAdmin(transport, validated.sender, streamId, actAs, logger);

  const adminCreate = buildStreamAdminCreate({
    streamId,
    sender: validated.sender,
    recipient: validated.recipient,
    operator: validated.escrowOperator,
    instrumentRef: validated.instrumentRef,
    totalDeposited: validated.totalDeposited,
    vestingMode: toStreamAdminVestingMode(validated.vestingMode),
    startTime: validated.startTime,
    endTime: validated.endTime,
    cancellable: validated.cancellable,
    observers: [],
  });
  const result = await transport.create(adminCreate.templateId, adminCreate.argument, actAs);

  logger.info(
    { streamId, contractId: result.contractId, settlementMode },
    'Stream request created',
  );

  return {
    requestContractId: result.contractId,
    streamId,
  };
}

/**
 * Create multiple streams in a single batch transaction.
 *
 * Each stream in the batch is created as an individual V2 `StreamAdmin`
 * observability contract. The V2 AllocationRequest / AllocationFactory
 * funding step remains wallet-driven.
 *
 * The batch itself is an SDK-level convenience — each stream request is an
 * independent on-ledger contract that the recipient must accept individually.
 */
export async function createBatch(
  transport: Transport,
  params: CreateBatchParams,
  actAs: string[],
  logger: Logger,
): Promise<{ batchContractId: string; streamIds: string[] }> {
  if (!params.streams || params.streams.length === 0) {
    throw new Error('Batch must contain at least one stream');
  }

  assertNoDuplicateBatchStreamIds(params.streams);

  logger.info({ count: params.streams.length }, 'Creating batch of stream requests');

  const streamIds: string[] = [];
  const contractIds: string[] = [];

  for (const streamParams of params.streams) {
    const result = await createStream(transport, streamParams, actAs, logger);
    streamIds.push(result.streamId);
    contractIds.push(result.requestContractId);
  }

  logger.info({ count: streamIds.length, streamIds }, 'Batch creation complete');

  return {
    batchContractId: contractIds[0] ?? '', // First contract ID as batch reference
    streamIds,
  };
}

function generateStreamId(): string {
  return crypto.randomUUID();
}

function toStreamAdminVestingMode(config: VestingModeConfig): StreamAdminVestingMode {
  switch (config.mode) {
    case VestingMode.Linear:
      return { tag: 'Linear' };
    case VestingMode.CliffLinear:
      return { tag: 'CliffLinear', cliffTime: config.cliffTime };
    case VestingMode.Stepped:
      return {
        tag: 'Stepped',
        stepIntervalMicros: BigInt(config.stepInterval),
        amountPerStep: config.amountPerStep,
      };
    case VestingMode.RenewableTerm:
      return {
        tag: 'RenewableTerm',
        termDurationMicros: BigInt(config.termDuration),
      };
  }
}

function assertActAsIncludesSender(actAs: string[], sender: string): void {
  if (!actAs.includes(sender)) {
    throw new Error(`actAs must include sender party "${sender}"`);
  }
}

async function assertNoDuplicateStreamAdmin(
  transport: Transport,
  sender: string,
  streamId: string,
  actAs: string[],
  logger: Logger,
): Promise<void> {
  try {
    const existing = await transport.query<any>(TEMPLATE_STREAM_ADMIN, undefined, actAs);
    const duplicate = existing.find((row) => row?.sender === sender && row?.streamId === streamId);
    if (duplicate) {
      throw new Error(`Stream already exists for sender="${sender}" and streamId="${streamId}"`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Stream already exists')) {
      throw err;
    }
    logger.warn?.(
      { sender, streamId, err },
      'Could not preflight duplicate StreamAdmin; proceeding with create',
    );
  }
}

function assertNoDuplicateBatchStreamIds(streams: ReadonlyArray<CreateStreamParams>): void {
  const seen = new Set<string>();
  for (const stream of streams) {
    const streamId = stream.streamId;
    if (!streamId) continue;
    const key = `${stream.sender}\u0000${streamId}`;
    if (seen.has(key)) {
      throw new Error(`Batch contains duplicate streamId="${streamId}" for sender="${stream.sender}"`);
    }
    seen.add(key);
  }
}
