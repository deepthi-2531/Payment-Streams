/**
 * Unit tests for commands/flow.ts — StreamFlow (non-prefunded /
 * rolling top-up) builders + dispatch.
 *
 * Covers:
 *   - buildFlowCreate payload shape (template id, signatories, initial
 *     state defaults, decimal/time encoding)
 *   - buildTopUpFlow / buildWithdrawFlow / buildPauseFlow /
 *     buildResumeFlow / buildStopFlow argument shapes + choice names
 *   - amount / party / reference validation guards
 *   - dispatch helpers (topUpFlow & friends) resolving the contract id
 *     from the ACS and exercising the right choice
 */

import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';

import {
  buildFlowCreate,
  buildTopUpFlow,
  buildWithdrawFlow,
  buildPauseFlow,
  buildResumeFlow,
  buildStopFlow,
  createFlow,
  topUpFlow,
  withdrawFlow,
  stopFlow,
  listFlows,
  type CreateFlowParams,
} from '../../src/commands/flow.js';
import { TEMPLATE_STREAM_FLOW } from '../../src/templates.js';
import type { Transport } from '../../src/transport/base.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => silentLogger),
} as never;

const SENDER = 'alice::aabbccdd0011';
const RECIPIENT = 'bob::aabbccdd0022';
const OPERATOR = 'carol::aabbccdd0033';

const activeFlowRow = {
  contractId: 'flow-cid-1',
  streamId: 'flow-001',
  sender: SENDER,
  recipient: RECIPIENT,
  escrowOperator: OPERATOR,
  instrumentRef: {
    depository: OPERATOR,
    issuer: OPERATOR,
    instrumentId: 'CC',
    instrumentVersion: 'v2',
  },
  flowRate: '0.0000010000',
  startTime: '2026-01-01T00:00:00Z',
  fundedAmount: '100.0000000000',
  totalWithdrawn: '0.0000000000',
  status: 'FlowActive',
  pausedAt: null,
  cumulativePausedDuration: { microseconds: '0' },
  lastSettlementReference: null,
  numIterations: '0',
  observers: [],
};

function mockTransport(rows: unknown[] = [activeFlowRow], newCid = 'flow-cid-2'): Transport {
  return {
    create: vi.fn(() => Promise.resolve({ contractId: 'flow-cid-1', result: {} } as never)),
    exercise: vi.fn(() => Promise.resolve(newCid as never)),
    exerciseByKey: vi.fn(),
    query: vi.fn(() => Promise.resolve(rows as never)),
    close: vi.fn(),
  } as unknown as Transport;
}

function commonCreateParams(overrides: Partial<CreateFlowParams> = {}): CreateFlowParams {
  return {
    streamId: 'flow-001',
    sender: SENDER,
    recipient: RECIPIENT,
    escrowOperator: OPERATOR,
    instrumentRef: {
      depository: OPERATOR,
      issuer: OPERATOR,
      instrumentId: 'CC',
      instrumentVersion: 'v2',
    },
    flowRate: new Decimal('0.000001'),
    fundedAmount: new Decimal('100'),
    startTime: new Date('2026-01-01T00:00:00Z'),
    observers: [],
    ...overrides,
  };
}

describe('buildFlowCreate', () => {
  it('emits the correct template id', () => {
    const payload = buildFlowCreate(commonCreateParams());
    expect(payload.templateId).toEqual(TEMPLATE_STREAM_FLOW);
    expect(payload.templateId.moduleName).toBe('CantonStreams.Stream.StreamFlow');
    expect(payload.templateId.entityName).toBe('StreamFlow');
  });

  it('includes all three signatories', () => {
    const payload = buildFlowCreate(commonCreateParams());
    expect(payload.signatories).toEqual([SENDER, RECIPIENT, OPERATOR]);
  });

  it('encodes the full create argument exactly', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const payload = buildFlowCreate(commonCreateParams({ startTime: start }));
    expect(payload.argument).toEqual({
      sender: { party: SENDER },
      recipient: { party: RECIPIENT },
      escrowOperator: { party: OPERATOR },
      streamId: { text: 'flow-001' },
      instrumentRef: {
        depository: { party: OPERATOR },
        issuer: { party: OPERATOR },
        instrumentId: { text: 'CC' },
        instrumentVersion: { text: 'v2' },
      },
      flowRate: { numeric: '0.0000010000' },
      startTime: { timestamp: (BigInt(start.getTime()) * 1000n).toString() },
      fundedAmount: { numeric: '100.0000000000' },
      totalWithdrawn: { numeric: '0.0000000000' },
      status: { enum: { enum_constructor: 'FlowActive' } },
      pausedAt: { optional: null },
      cumulativePausedDuration: { microseconds: { int64: '0' } },
      lastSettlementReference: { optional: null },
      numIterations: { int64: '0' },
      observers: [],
    });
  });

  it('serializes decimals with 10 decimal places', () => {
    const payload = buildFlowCreate(
      commonCreateParams({ flowRate: '0.5', fundedAmount: '1234.567' }),
    );
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.flowRate).toEqual({ numeric: '0.5000000000' });
    expect(arg.fundedAmount).toEqual({ numeric: '1234.5670000000' });
  });

  it('allows a zero initial funded balance', () => {
    const payload = buildFlowCreate(commonCreateParams({ fundedAmount: 0 }));
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.fundedAmount).toEqual({ numeric: '0.0000000000' });
  });

  it('passes observers through as parties', () => {
    const payload = buildFlowCreate(
      commonCreateParams({ observers: ['obs::aabbccdd0044'] }),
    );
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.observers).toEqual([{ party: 'obs::aabbccdd0044' }]);
  });

  it('rejects a non-positive flow rate', () => {
    expect(() => buildFlowCreate(commonCreateParams({ flowRate: 0 }))).toThrow(/flowRate/);
    expect(() => buildFlowCreate(commonCreateParams({ flowRate: '-1' }))).toThrow(/flowRate/);
  });

  it('rejects a negative funded amount', () => {
    expect(() => buildFlowCreate(commonCreateParams({ fundedAmount: -5 }))).toThrow(
      /fundedAmount/,
    );
  });

  it('rejects malformed party ids', () => {
    expect(() => buildFlowCreate(commonCreateParams({ sender: 'no-fingerprint' }))).toThrow(
      /sender/,
    );
    expect(() => buildFlowCreate(commonCreateParams({ recipient: '' }))).toThrow(/recipient/);
    expect(() =>
      buildFlowCreate(commonCreateParams({ escrowOperator: 'evil,party::deadbeef01' })),
    ).toThrow(/escrowOperator/);
  });
});

describe('buildTopUpFlow', () => {
  it('emits TopUp_Flow with exact argument encoding', () => {
    const payload = buildTopUpFlow({
      topUpAmount: new Decimal('50'),
      settlementReference: 'topup-ref-1',
    });
    expect(payload.templateId).toEqual(TEMPLATE_STREAM_FLOW);
    expect(payload.choiceName).toBe('TopUp_Flow');
    expect(payload.argument).toEqual({
      topUpAmount: { numeric: '50.0000000000' },
      settlementReference: { text: 'topup-ref-1' },
    });
  });

  it('rejects a non-positive top-up amount', () => {
    expect(() =>
      buildTopUpFlow({ topUpAmount: 0, settlementReference: 'ref' }),
    ).toThrow(/topUpAmount/);
  });

  it('rejects an empty settlement reference', () => {
    expect(() =>
      buildTopUpFlow({ topUpAmount: 1, settlementReference: '' }),
    ).toThrow(/settlementReference/);
  });
});

describe('buildWithdrawFlow', () => {
  it('emits Withdraw_Flow with exact argument encoding', () => {
    const at = new Date('2026-02-01T00:00:00Z');
    const payload = buildWithdrawFlow({
      withdrawTime: at,
      settlementReference: 'withdraw-ref-1',
    });
    expect(payload.templateId).toEqual(TEMPLATE_STREAM_FLOW);
    expect(payload.choiceName).toBe('Withdraw_Flow');
    expect(payload.argument).toEqual({
      withdrawTime: { timestamp: (BigInt(at.getTime()) * 1000n).toString() },
      settlementReference: { text: 'withdraw-ref-1' },
    });
  });

  it('rejects an empty settlement reference', () => {
    expect(() => buildWithdrawFlow({ settlementReference: '  ' })).toThrow(
      /settlementReference/,
    );
  });
});

describe('buildPauseFlow / buildResumeFlow', () => {
  it('emit Pause_Flow / Resume_Flow with timestamp arguments', () => {
    const at = new Date('2026-03-01T00:00:00Z');
    const micros = (BigInt(at.getTime()) * 1000n).toString();

    const pause = buildPauseFlow({ pauseTime: at });
    expect(pause.choiceName).toBe('Pause_Flow');
    expect(pause.argument).toEqual({ pauseTime: { timestamp: micros } });

    const resume = buildResumeFlow({ resumeTime: at });
    expect(resume.choiceName).toBe('Resume_Flow');
    expect(resume.argument).toEqual({ resumeTime: { timestamp: micros } });
  });
});

describe('buildStopFlow', () => {
  it('emits Stop_Flow with exact argument encoding (refs present)', () => {
    const at = new Date('2026-04-01T00:00:00Z');
    const payload = buildStopFlow({
      stopTime: at,
      recipientSettlement: new Decimal('75.5'),
      senderRefund: new Decimal('24.5'),
      recipientSettlementReference: 'final-settle-ref',
      senderRefundReference: 'refund-ref',
    });
    expect(payload.templateId).toEqual(TEMPLATE_STREAM_FLOW);
    expect(payload.choiceName).toBe('Stop_Flow');
    expect(payload.argument).toEqual({
      stopTime: { timestamp: (BigInt(at.getTime()) * 1000n).toString() },
      recipientSettlement: { numeric: '75.5000000000' },
      senderRefund: { numeric: '24.5000000000' },
      recipientSettlementReference: { optional: { text: 'final-settle-ref' } },
      senderRefundReference: { optional: { text: 'refund-ref' } },
    });
  });

  it('encodes None for omitted references', () => {
    const payload = buildStopFlow({ recipientSettlement: 0, senderRefund: 0 });
    const arg = payload.argument as Record<string, unknown>;
    expect(arg.recipientSettlementReference).toEqual({ optional: null });
    expect(arg.senderRefundReference).toEqual({ optional: null });
  });

  it('allows zero settlement legs but rejects negatives', () => {
    expect(() => buildStopFlow({ recipientSettlement: 0, senderRefund: 0 })).not.toThrow();
    expect(() => buildStopFlow({ recipientSettlement: -1, senderRefund: 0 })).toThrow(
      /recipientSettlement/,
    );
    expect(() => buildStopFlow({ recipientSettlement: 0, senderRefund: '-0.1' })).toThrow(
      /senderRefund/,
    );
  });
});

describe('createFlow', () => {
  it('creates with the built payload and returns cid + streamId', async () => {
    const transport = mockTransport();
    const result = await createFlow(
      transport,
      commonCreateParams(),
      [SENDER, RECIPIENT, OPERATOR],
      silentLogger,
    );
    expect(result).toEqual({ contractId: 'flow-cid-1', streamId: 'flow-001' });
    const [tmpl, , actAs] = (transport.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tmpl).toEqual(TEMPLATE_STREAM_FLOW);
    expect(actAs).toEqual([SENDER, RECIPIENT, OPERATOR]);
  });

  it('generates a streamId when omitted', async () => {
    const transport = mockTransport();
    const result = await createFlow(
      transport,
      commonCreateParams({ streamId: undefined }),
      [SENDER, RECIPIENT, OPERATOR],
      silentLogger,
    );
    expect(result.streamId).toBeTruthy();
  });

  it('requires actAs to include the sender', async () => {
    const transport = mockTransport();
    await expect(
      createFlow(transport, commonCreateParams(), [RECIPIENT], silentLogger),
    ).rejects.toThrow(/actAs must include sender/);
  });
});

describe('flow exercise dispatch', () => {
  it('topUpFlow resolves the cid from ACS and exercises TopUp_Flow', async () => {
    const transport = mockTransport();
    const result = await topUpFlow(
      transport,
      SENDER,
      'flow-001',
      { topUpAmount: 25, settlementReference: 'ref-1' },
      [SENDER, OPERATOR],
      silentLogger,
    );
    expect(result).toEqual({ newFlowCid: 'flow-cid-2' });
    const [tmpl, cid, choice, arg, actAs] = (
      transport.exercise as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(tmpl).toEqual(TEMPLATE_STREAM_FLOW);
    expect(cid).toBe('flow-cid-1');
    expect(choice).toBe('TopUp_Flow');
    expect(arg).toEqual({
      topUpAmount: { numeric: '25.0000000000' },
      settlementReference: { text: 'ref-1' },
    });
    expect(actAs).toEqual([SENDER, OPERATOR]);
  });

  it('withdrawFlow exercises Withdraw_Flow on the matched contract', async () => {
    const transport = mockTransport();
    await withdrawFlow(
      transport,
      SENDER,
      'flow-001',
      { settlementReference: 'ref-2', withdrawTime: new Date('2026-02-01T00:00:00Z') },
      [RECIPIENT, OPERATOR],
      silentLogger,
    );
    const [, cid, choice] = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cid).toBe('flow-cid-1');
    expect(choice).toBe('Withdraw_Flow');
  });

  it('stopFlow exercises Stop_Flow', async () => {
    const transport = mockTransport();
    await stopFlow(
      transport,
      SENDER,
      'flow-001',
      { recipientSettlement: 1, senderRefund: 99 },
      [SENDER, RECIPIENT, OPERATOR],
      silentLogger,
    );
    const [, , choice] = (transport.exercise as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(choice).toBe('Stop_Flow');
  });

  it('throws when the flow is not found', async () => {
    const transport = mockTransport([]);
    await expect(
      topUpFlow(
        transport,
        SENDER,
        'missing-flow',
        { topUpAmount: 1, settlementReference: 'ref' },
        [SENDER, OPERATOR],
        silentLogger,
      ),
    ).rejects.toThrow(/Flow not found/);
  });
});

describe('listFlows', () => {
  it('decodes active contracts into FlowInfo', async () => {
    const transport = mockTransport();
    const flows = await listFlows(transport, undefined, [SENDER], undefined, silentLogger);
    expect(flows).toHaveLength(1);
    const flow = flows[0]!;
    expect(flow.contractId).toBe('flow-cid-1');
    expect(flow.streamId).toBe('flow-001');
    expect(flow.sender).toBe(SENDER);
    expect(flow.recipient).toBe(RECIPIENT);
    expect(flow.escrowOperator).toBe(OPERATOR);
    expect(flow.flowRate.toString()).toBe('0.000001');
    expect(flow.fundedAmount.toString()).toBe('100');
    expect(flow.totalWithdrawn.toString()).toBe('0');
    expect(flow.status).toBe('FlowActive');
    expect(flow.pausedAt).toBeUndefined();
    expect(flow.cumulativePausedMicros).toBe(0);
    expect(flow.numIterations).toBe(0);
  });

  it('applies sender / recipient / status filters', async () => {
    const stopped = { ...activeFlowRow, contractId: 'flow-cid-9', streamId: 'flow-009', status: 'FlowStopped' };
    const transport = mockTransport([activeFlowRow, stopped]);
    const active = await listFlows(
      transport,
      { sender: SENDER, status: 'FlowActive' },
      [SENDER],
      undefined,
      silentLogger,
    );
    expect(active.map((f) => f.streamId)).toEqual(['flow-001']);

    const other = await listFlows(
      transport,
      { recipient: 'nobody::aabbccdd0099' },
      [SENDER],
      undefined,
      silentLogger,
    );
    expect(other).toHaveLength(0);
  });

  it('returns an empty list when the template is not deployed', async () => {
    const transport = {
      query: vi.fn(() => Promise.reject(new Error('template not found'))),
    } as unknown as Transport;
    const flows = await listFlows(transport, undefined, [SENDER], undefined, silentLogger);
    expect(flows).toEqual([]);
  });
});
