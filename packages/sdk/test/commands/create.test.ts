import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { createStream } from '../../src/commands/create.js';
import { AssetType, SettlementMode, VestingMode } from '../../src/types/stream.js';
import { TEMPLATE_LOCAL_ASSET_CREATE_REQUEST } from '../../src/templates.js';

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

describe('createStream', () => {
  it('creates local-asset streams without instrumentRef', async () => {
    const transport = {
      create: vi.fn().mockResolvedValue({ contractId: '#request-001', result: {} }),
    } as any;

    const result = await createStream(
      transport,
      {
        streamId: 'local-asset-stream',
        sender: 'alice',
        recipient: 'bob',
        totalDeposited: new Decimal('100'),
        startTime: new Date('2026-03-31T00:00:00Z'),
        endTime: new Date('2026-04-01T00:00:00Z'),
        vestingMode: { mode: VestingMode.Linear },
        assetType: AssetType.ValidatorLocalAsset,
        holdingCid: '#holding-001',
        recipientAccount: { owner: 'bob', accountNumber: 'recipient-1' },
        settlementMode: SettlementMode.LocalAssetCustody,
        escrowOperator: 'escrow-operator',
        cancellable: true,
      },
      ['alice'],
      logger,
    );

    expect(result).toEqual({
      requestContractId: '#request-001',
      streamId: 'local-asset-stream',
    });

    expect(transport.create).toHaveBeenCalledWith(
      TEMPLATE_LOCAL_ASSET_CREATE_REQUEST,
      expect.objectContaining({
        fundingHoldingCid: { contract_id: '#holding-001' },
        depositAmount: { numeric: '100' },
        escrowOperator: { party: 'escrow-operator' },
        recipientAccount: { owner: 'bob', accountNumber: 'recipient-1' },
        observers: [],
      }),
      ['alice'],
    );

    const payload = transport.create.mock.calls[0][1];
    expect(payload).not.toHaveProperty('symbol');
    expect(payload).not.toHaveProperty('issuer');
  });

  it('rejects local-asset streams without recipientAccount', async () => {
    const transport = {
      create: vi.fn(),
    } as any;

    await expect(
      createStream(
        transport,
        {
          streamId: 'local-asset-stream',
          sender: 'alice',
          recipient: 'bob',
          totalDeposited: new Decimal('100'),
          startTime: new Date('2026-03-31T00:00:00Z'),
          endTime: new Date('2026-04-01T00:00:00Z'),
          vestingMode: { mode: VestingMode.Linear },
          assetType: AssetType.ValidatorLocalAsset,
          holdingCid: '#holding-001',
          settlementMode: SettlementMode.LocalAssetCustody,
          escrowOperator: 'escrow-operator',
          cancellable: true,
        } as any,
        ['alice'],
        logger,
      ),
    ).rejects.toThrow('recipientAccount');
  });
});
