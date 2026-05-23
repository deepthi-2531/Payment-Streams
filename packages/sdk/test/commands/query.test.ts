import { describe, expect, it, vi } from 'vitest';
import { getStream, getStreamHistory } from '../../src/commands/query.js';
import {
  TEMPLATE_STREAM_ESCROW,
  TEMPLATE_TOKEN_STANDARD_ESCROW,
  TEMPLATE_UTILITY_ESCROW,
  TEMPLATE_LOCAL_ASSET_ESCROW,
} from '../../src/templates.js';
import { SettlementMode, StreamStatus } from '../../src/types/stream.js';

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

const sender = 'Sender::party';
const recipient = 'Receiver::party';
const escrowOperator = 'Escrow::party';
const streamId = 'archived-hybrid-stream';

const templateKey = (templateId: { packageId: string; moduleName: string; entityName: string }) =>
  `${templateId.packageId}:${templateId.moduleName}:${templateId.entityName}`;

const text = (value: string) => ({ text: value });
const party = (value: string) => ({ party: value });
const numeric = (value: string) => ({ numeric: value });
const int64 = (value: string) => ({ int64: value });
const timestamp = (value: string) => ({ timestamp: value });
const enumValue = (value: string) => ({ enum: { enum_constructor: value } });
const unit = () => ({ unit: {} });
const variant = (tag: string, value: Record<string, unknown> = unit()) => ({
  variant: {
    variant_constructor: tag,
    value,
  },
});
const optional = (value?: Record<string, unknown>) =>
  value ? { optional: { value } } : { optional: {} };
const record = (fields: Array<[string, Record<string, unknown>]>) => ({
  fields: fields.map(([label, value]) => ({ label, value })),
});

function makeTokenStandardCreateArguments({
  totalWithdrawn,
  status,
  escrowAmount,
  vestingMode = variant('Linear'),
}: {
  totalWithdrawn: string;
  status: StreamStatus;
  escrowAmount: string;
  vestingMode?: Record<string, unknown>;
}) {
  return record([
    [
      'config',
      {
        record: record([
          ['streamId', text(streamId)],
          ['sender', party(sender)],
          ['recipient', party(recipient)],
          ['totalDeposited', numeric('5.0000000000')],
          ['startTime', timestamp('2026-04-02T03:00:00.000Z')],
          ['endTime', timestamp('2026-04-02T03:02:05.000Z')],
          ['vestingMode', vestingMode],
          ['assetType', variant('GlobalCip56')],
          [
            'instrumentRef',
            optional({
              record: record([
                ['depository', party('Depository::party')],
                ['issuer', party('Issuer::party')],
                ['instrumentId', text('Amulet')],
                ['instrumentVersion', text('1')],
              ]),
            }),
          ],
          ['cancellable', { bool: true }],
        ]),
      },
    ],
    [
      'state',
      {
        record: record([
          ['totalWithdrawn', numeric(totalWithdrawn)],
          ['status', enumValue(status)],
          ['lastWithdrawTime', optional(timestamp('2026-04-02T03:35:00.000Z'))],
          ['renewalCount', int64('0')],
        ]),
      },
    ],
    ['escrowOperator', party(escrowOperator)],
    ['escrowReference', text('escrow-ref-001')],
    ['escrowAmount', numeric(escrowAmount)],
    ['fundingReference', text('funding-ref-001')],
    ['senderAccountRef', text('{"wallet":"sender"}')],
    ['recipientAccountRef', text('{"wallet":"recipient"}')],
    ['lastSettlementReference', optional(text('settlement-ref-001'))],
    ['observers', { list: { elements: [] } }],
  ]);
}

function makeTransport() {
  const query = vi.fn(async (templateId: any) => {
    const key = templateKey(templateId);
    if (
      key === templateKey(TEMPLATE_STREAM_ESCROW) ||
      key === templateKey(TEMPLATE_UTILITY_ESCROW) ||
      key === templateKey(TEMPLATE_TOKEN_STANDARD_ESCROW) ||
      key === templateKey(TEMPLATE_LOCAL_ASSET_ESCROW)
    ) {
      return [];
    }
    return [];
  });

  const historicalUpdatesByTemplate = new Map<string, any[]>([
    [
      templateKey(TEMPLATE_TOKEN_STANDARD_ESCROW),
      [
        {
          transaction: {
            offset: '23990',
            effective_at: '2026-04-02T03:34:55.000Z',
            events: [
              {
                created: {
                  contract_id: '#stream-live',
                  created_at: '2026-04-02T03:34:55.000Z',
                  create_arguments: makeTokenStandardCreateArguments({
                    totalWithdrawn: '4.8000000000',
                    status: StreamStatus.Active,
                    escrowAmount: '0.2000000000',
                  }),
                },
              },
            ],
          },
        },
        {
          transaction: {
            offset: '24001',
            effective_at: '2026-04-02T03:35:00.000Z',
            events: [
              {
                exercised: {
                  contract_id: '#stream-live',
                  choice: 'Withdraw_TokenStandard',
                  exercise_result: {
                    record: record([
                      ['amountWithdrawn', numeric('0.2000000000')],
                      ['newTotalWithdrawn', numeric('5.0000000000')],
                      ['newStatus', enumValue(StreamStatus.Completed)],
                    ]),
                  },
                },
              },
              {
                created: {
                  contract_id: '#stream-completed',
                  created_at: '2026-04-02T03:35:00.000Z',
                  create_arguments: makeTokenStandardCreateArguments({
                    totalWithdrawn: '5.0000000000',
                    status: StreamStatus.Completed,
                    escrowAmount: '0.0000000000',
                  }),
                },
              },
            ],
          },
        },
      ],
    ],
  ]);

  const getUpdates = vi.fn(
    (
      templateId: any,
      beginOffset: string,
      endOffset: string | undefined,
      _actAs: string[],
      _readAs: string[] | undefined,
      onUpdate: (update: any) => void,
      _onError: (err: Error) => void,
      onEnd: () => void,
    ) => {
      const key = templateKey(templateId);
      queueMicrotask(() => {
        if (
          key === templateKey(TEMPLATE_TOKEN_STANDARD_ESCROW) &&
          beginOffset === '15000' &&
          endOffset === '25000'
        ) {
          for (const update of historicalUpdatesByTemplate.get(key) ?? []) {
            onUpdate(update);
          }
        }
        onEnd();
      });
      return () => undefined;
    },
  );

  return {
    query,
    getUpdates,
    getLedgerEnd: vi.fn().mockResolvedValue('25000'),
  } as any;
}

describe('query archived streams', () => {
  it('reconstructs a completed token-standard stream from recent history', async () => {
    const transport = makeTransport();

    const stream = await getStream(
      transport,
      sender,
      streamId,
      [sender],
      logger,
    );

    expect(stream.contractId).toBe('#stream-completed');
    expect(stream.config.streamId).toBe(streamId);
    expect(stream.config.sender).toBe(sender);
    expect(stream.config.recipient).toBe(recipient);
    expect(stream.config.settlementMode).toBe(SettlementMode.TokenStandardCustody);
    expect(stream.state.status).toBe(StreamStatus.Completed);
    expect(stream.state.totalWithdrawn.toFixed(10)).toBe('5.0000000000');
    expect(stream.escrowRef?.escrowAmount).toBe('0.0000000000');
  });

  it('deserializes stepped vesting reltime fields from archived stream history', async () => {
    const transport = makeTransport();
    transport.getUpdates = vi.fn(
      (
        templateId: any,
        beginOffset: string,
        endOffset: string | undefined,
        _actAs: string[],
        _readAs: string[] | undefined,
        onUpdate: (update: any) => void,
        _onError: (err: Error) => void,
        onEnd: () => void,
      ) => {
        const key = templateKey(templateId);
        queueMicrotask(() => {
          if (
            key === templateKey(TEMPLATE_TOKEN_STANDARD_ESCROW) &&
            beginOffset === '15000' &&
            endOffset === '25000'
          ) {
            onUpdate({
              transaction: {
                offset: '24010',
                effective_at: '2026-04-02T03:36:00.000Z',
                events: [
                  {
                    created: {
                      contract_id: '#stream-stepped',
                      created_at: '2026-04-02T03:36:00.000Z',
                      create_arguments: makeTokenStandardCreateArguments({
                        totalWithdrawn: '0.0500000000',
                        status: StreamStatus.Active,
                        escrowAmount: '0.2000000000',
                        vestingMode: variant('Stepped', record([
                          ['stepInterval', record([['microseconds', text('60000000')]])],
                          ['amountPerStep', text('0.0500000000')],
                        ])),
                      }),
                    },
                  },
                ],
              },
            });
          }
          onEnd();
        });
        return () => undefined;
      },
    );

    const stream = await getStream(transport, sender, streamId, [sender], logger);

    expect(stream.config.vestingMode.mode).toBe('Stepped');
    expect(stream.config.vestingMode).toMatchObject({
      mode: 'Stepped',
      stepInterval: 60_000_000,
    });
  });

  it('returns archived stream history without scanning from offset 0', async () => {
    const transport = makeTransport();

    const events = await getStreamHistory(
      transport,
      sender,
      streamId,
      [sender],
      logger,
    );

    expect(events.map((event) => event.type)).toEqual([
      'created',
      'withdrawn',
      'completed',
    ]);

    expect(
      transport.getUpdates.mock.calls.some(
        (call: any[]) =>
          templateKey(call[0]) === templateKey(TEMPLATE_TOKEN_STANDARD_ESCROW) &&
          call[1] === '0',
      ),
    ).toBe(false);
    expect(
      transport.getUpdates.mock.calls.some(
        (call: any[]) =>
          templateKey(call[0]) === templateKey(TEMPLATE_TOKEN_STANDARD_ESCROW) &&
          call[1] === '15000' &&
          call[2] === '25000',
      ),
    ).toBe(true);
  });
});
