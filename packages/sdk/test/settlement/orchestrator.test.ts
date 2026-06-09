import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';

import { SettlementOrchestrator } from '../../src/settlement/orchestrator.js';

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

function tokenStandardEscrowRow(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'escrow-contract-1',
    config: {
      sender: 'Sender::1',
      recipient: 'Recipient::1',
      streamId: 'stream-1',
      totalDeposited: '0.5000000000',
      startTime: '2026-04-03T12:00:00.000Z',
      endTime: '2026-04-03T12:00:10.000Z',
      vestingMode: { tag: 'Linear', value: {} },
      assetType: 'GlobalHolding',
      instrumentRef: {
        issuer: 'Registrar::1',
        depository: 'Registrar::1',
        instrumentId: 'USDCx',
        instrumentVersion: 'testnet',
      },
      cancellable: true,
    },
    state: {
      totalWithdrawn: '0.0000000000',
      status: 'Active',
      renewalCount: 0,
      ...((overrides['state'] as Record<string, unknown> | undefined) ?? {}),
    },
    escrowReference: 'escrow-ref-1',
    escrowAmount: '0.5000000000',
    escrowOperator: 'Escrow::1',
    fundingReference: 'funding-ref-1',
    senderAccountRef: '{"party":"Sender::1"}',
    recipientAccountRef: '{"party":"Recipient::1"}',
    lastSettlementReference: { tag: 'None', value: {} },
    ...overrides,
  };
}

describe('SettlementOrchestrator', () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    'CANTON_JSON_API_URL',
    'CANTON_LEDGER_TOKEN',
    'CANTON_USER_ID',
    'SYNCHRONIZER_ID',
    'CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON',
    // These tests verify the orchestrator's wire logic against mocks,
    // not the legacy TokenStandardEscrow template, so the guard is
    // explicitly enabled for this suite.
    'CANTON_STREAMS_TOKEN_STANDARD_ESCROW_PRESENT',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T12:00:10.000Z'));
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
    }
    process.env['CANTON_STREAMS_TOKEN_STANDARD_ESCROW_PRESENT'] = 'true';
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('falls back to interactive withdraw for hybrid escrow signers', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    process.env.CANTON_JSON_API_URL = 'https://ledger.example';
    process.env.CANTON_LEDGER_TOKEN = 'ledger-token';
    process.env.CANTON_USER_ID = 'streams-service';
    process.env.SYNCHRONIZER_ID = 'sync::1';
    process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
      'Escrow::1': {
        publicKey: 'escrow-public-key',
        privateKey: privateKeyPem,
      },
    });

    const adapter = {
      canHandle: vi.fn(async () => true),
      transfer: vi.fn(async () => ({
        settlementReference: 'receiver-accept-update-1',
        amount: new Decimal('0.5000000000'),
        receiverAccepted: true,
      })),
    };

    let streamRows = [tokenStandardEscrowRow()];
    const fetchCalls: Array<{ url: string; body: any }> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });

      if (url.endsWith('/v2/interactive-submission/prepare')) {
        return new Response(JSON.stringify({
          preparedTransactionHash: Buffer.from('prepared-withdraw-hash').toString('base64'),
          preparedTransaction: 'prepared-withdraw-transaction',
          hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
        }), { status: 200 });
      }

      if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
        streamRows = [
          tokenStandardEscrowRow({
            state: {
              totalWithdrawn: '0.5000000000',
              status: 'Completed',
              renewalCount: 0,
              lastWithdrawTime: '2026-04-03T12:00:10.000Z',
            },
            escrowAmount: '0.0000000000',
            lastSettlementReference: {
              tag: 'Some',
              value: 'receiver-accept-update-1',
            },
          }),
        ];
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    }) as any;

    const transport = {
      create: vi.fn(),
      close: vi.fn(),
      exercise: vi.fn(async () => {
        throw new Error(
          'Ledger API error (gRPC 5): NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT',
        );
      }),
      exerciseByKey: vi.fn(),
      query: vi.fn(async (templateId: { entityName?: string }) =>
        templateId?.entityName === 'TokenStandardEscrow' ? streamRows : [],
      ),
    } as any;

    const orchestrator = new SettlementOrchestrator([adapter as any]);

    const result = await orchestrator.withdraw(
      transport,
      'Sender::1',
      'stream-1',
      ['Escrow::1', 'Recipient::1'],
      logger,
    );

    expect(result.amountWithdrawn.toFixed(10)).toBe('0.5000000000');
    expect(result.newTotalWithdrawn.toFixed(10)).toBe('0.5000000000');
    expect(result.newStatus).toBe('Completed');
    expect(result.settlementReference).toBe('receiver-accept-update-1');

    expect(transport.exercise).toHaveBeenCalledTimes(1);
    expect(transport.exercise.mock.calls[0]?.[4]).toEqual(['Escrow::1']);

    expect(adapter.transfer).toHaveBeenCalledTimes(1);

    const prepareCall = fetchCalls.find((call) =>
      call.url.endsWith('/v2/interactive-submission/prepare'),
    );
    expect(prepareCall?.body?.actAs).toEqual(['Escrow::1']);
    expect(
      prepareCall?.body?.commands?.[0]?.ExerciseCommand?.choiceArgument,
    ).toEqual({
      withdrawTime: '2026-04-03T12:00:10.000Z',
      settlementReference: 'receiver-accept-update-1',
      settledAmount: '0.5000000000',
    });

    const executeCall = fetchCalls.find((call) =>
      call.url.endsWith('/v2/interactive-submission/executeAndWait'),
    );
    expect(executeCall?.body?.submissionId).toMatch(/^canton-streams\.withdraw\./);
  });
});
