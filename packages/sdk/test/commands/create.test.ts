import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import { createBatch, createStream } from '../../src/commands/create.js';
import { AssetType, SettlementMode, VestingMode } from '../../src/types/stream.js';
import { TEMPLATE_STREAM_ADMIN } from '../../src/templates.js';

const logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child: () => logger,
} as any;

const validParams = {
  streamId: 'v2-stream',
  sender: 'alice',
  recipient: 'bob',
  totalDeposited: new Decimal('100'),
  startTime: new Date('2026-03-31T00:00:00Z'),
  endTime: new Date('2026-04-01T00:00:00Z'),
  vestingMode: { mode: VestingMode.Linear },
  assetType: AssetType.GlobalCip56,
  instrumentRef: {
    depository: 'AmuletAdmin::1',
    issuer: 'AmuletAdmin::1',
    instrumentId: 'Amulet',
    instrumentVersion: 'v2',
  },
  fundingReference: 'source-allocation',
  senderAccount: { owner: 'alice', id: '' },
  recipientAccount: { owner: 'bob', id: '' },
  settlementMode: SettlementMode.TokenStandardCustody,
  escrowOperator: 'escrow-operator',
  cancellable: true,
};

describe('createStream', () => {
  it('creates a V2 StreamAdmin contract for token-standard streams', async () => {
    const transport = {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ contractId: '#stream-admin-001', result: {} }),
    } as any;

    const result = await createStream(transport, validParams, ['alice'], logger);

    expect(result).toEqual({
      requestContractId: '#stream-admin-001',
      streamId: 'v2-stream',
    });

    expect(transport.create).toHaveBeenCalledWith(
      TEMPLATE_STREAM_ADMIN,
      expect.objectContaining({
        streamId: { text: 'v2-stream' },
        sender: { party: 'alice' },
        recipient: { party: 'bob' },
        operator: { party: 'escrow-operator' },
        // V2 asset identity `{ admin, id }` — the builder converts the
        // public `instrumentRef` input internally (admin = issuer, id =
        // instrumentId); the V1 depository/instrumentVersion fields are
        // dropped (no V2 equivalent).
        instrumentId: {
          admin: { party: 'AmuletAdmin::1' },
          id: { text: 'Amulet' },
        },
        totalDeposited: { numeric: '100.0000000000' },
        currentAllocationCid: { optional: null },
      }),
      ['alice'],
    );
  });

  it('rejects legacy settlement modes for new streams', async () => {
    const transport = { query: vi.fn().mockResolvedValue([]), create: vi.fn() } as any;

    await expect(
      createStream(
        transport,
        {
          ...validParams,
          settlementMode: SettlementMode.LocalAssetCustody,
          holdingCid: '#holding-001',
        },
        ['alice'],
        logger,
      ),
    ).rejects.toThrow('TokenStandardCustody');
  });

  it('rejects duplicate V2 StreamAdmin ids visible to the sender', async () => {
    const transport = {
      query: vi.fn().mockResolvedValue([{ sender: 'alice', streamId: 'v2-stream' }]),
      create: vi.fn(),
    } as any;

    await expect(createStream(transport, validParams, ['alice'], logger)).rejects.toThrow(
      'Stream already exists',
    );
    expect(transport.create).not.toHaveBeenCalled();
  });
});

describe('createBatch', () => {
  it('rejects duplicate stream ids within the same sender batch', async () => {
    const transport = {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    } as any;

    await expect(
      createBatch(
        transport,
        { streams: [validParams, { ...validParams, recipient: 'charlie' }] },
        ['alice'],
        logger,
      ),
    ).rejects.toThrow('Batch contains duplicate streamId');
    expect(transport.create).not.toHaveBeenCalled();
  });
});
