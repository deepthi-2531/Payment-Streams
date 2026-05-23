import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import Decimal from 'decimal.js';

import {
  executeInteractiveWithdraw,
  extractDiscoveredTokenStandardStreams,
  findEligibleTokenStandardStreams,
  parseAutoWithdrawConfig,
  __resetSigningResolverForTests,
} from '../dist/auto-withdraw.js';

const now = new Date('2026-04-01T06:00:00.000Z');

function activeTokenStandardStream(overrides = {}) {
  return {
    contractId: 'cid-1',
    config: {
      sender: 'Sender::1',
      recipient: 'Recipient::1',
      streamId: 'stream-1',
      totalDeposited: new Decimal('10.0'),
      startTime: new Date('2026-04-01T05:59:00.000Z'),
      endTime: new Date('2026-04-01T06:15:40.000Z'),
      vestingMode: { mode: 'Linear' },
      cancellable: true,
      settlementMode: 'TokenStandardCustody',
      ...overrides.config,
    },
    state: {
      totalWithdrawn: new Decimal('0'),
      status: 'Active',
      renewalCount: 0,
      ...overrides.state,
    },
    escrowRef: {
      escrowHoldingCid: 'escrow-cid',
      escrowAmount: '10.0000000000',
      escrowOperator: 'Escrow::1',
      instrumentRef: {
        depository: 'Registrar::1',
        issuer: 'Registrar::1',
        instrumentId: 'CC',
        instrumentVersion: 'testnet',
      },
      recipientAccount: {},
      ...overrides.escrowRef,
    },
  };
}

test('parseAutoWithdrawConfig defaults to disabled and 10s polling', () => {
  const config = parseAutoWithdrawConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.pollIntervalMs, 10_000);
  assert.equal(config.interactiveEnabled, false);
  assert.equal(config.recipientAutoAcceptEnabled, false);
  assert.equal(config.hostWalletAdapter, 'wallet-gateway-transfer-accept');
  assert.equal(config.recipientPendingPollAttempts, 24);
  assert.equal(config.recipientPendingPollIntervalMs, 2_500);
  assert.deepEqual(config.discoveryParties, []);
  // STR-90: in-process signing is the default until M3 cutover completes.
  assert.equal(config.useSigningProvider, false);
});

test('parseAutoWithdrawConfig enables SigningProvider routing when env flag set', () => {
  const config = parseAutoWithdrawConfig({
    PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER: 'true',
  });
  assert.equal(config.useSigningProvider, true);
});

test('parseAutoWithdrawConfig parses hybrid interactive settings', () => {
  const config = parseAutoWithdrawConfig({
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_ENABLED: 'true',
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_POLL_INTERVAL_MS: '5000',
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_INTERACTIVE_ENABLED: 'yes',
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_RECIPIENT_AUTOACCEPT_ENABLED: 'true',
    PROXY_TOKEN_STANDARD_HOST_WALLET_ADAPTER: 'wallet-api-claim',
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_RECIPIENT_PENDING_POLL_ATTEMPTS: '12',
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_RECIPIENT_PENDING_POLL_INTERVAL_MS: '1500',
    PROXY_TOKEN_STANDARD_AUTOWITHDRAW_DISCOVERY_PARTIES: 'Sender::1, Recipient::1 ,Escrow::1',
    CANTON_JSON_API_URL: 'https://ledger.example',
    PROXY_SERVICE_USER_ID: 'streams-service',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.pollIntervalMs, 5_000);
  assert.equal(config.interactiveEnabled, true);
  assert.equal(config.recipientAutoAcceptEnabled, true);
  assert.equal(config.hostWalletAdapter, 'wallet-api-claim');
  assert.equal(config.recipientPendingPollAttempts, 12);
  assert.equal(config.recipientPendingPollIntervalMs, 1_500);
  assert.deepEqual(config.discoveryParties, ['Sender::1', 'Recipient::1', 'Escrow::1']);
  assert.equal(config.jsonApiUrl, 'https://ledger.example');
  assert.equal(config.serviceUserId, 'streams-service');
});

test('findEligibleTokenStandardStreams includes active matching streams with balance', () => {
  const candidates = findEligibleTokenStandardStreams(
    [activeTokenStandardStream()],
    'Escrow::1',
    now,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.streamId, 'stream-1');
  assert.equal(candidates[0]?.withdrawable, '0.6000000000');
});

test('findEligibleTokenStandardStreams skips wrong operator, zero balance, and non-active streams', () => {
  const candidates = findEligibleTokenStandardStreams(
    [
      activeTokenStandardStream({ escrowRef: { escrowOperator: 'OtherEscrow::1' } }),
      activeTokenStandardStream({
        state: {
          totalWithdrawn: new Decimal('0.6000000000'),
        },
      }),
      activeTokenStandardStream({
        state: {
          status: 'Completed',
        },
      }),
    ],
    'Escrow::1',
    now,
  );

  assert.equal(candidates.length, 0);
});

test('extractDiscoveredTokenStandardStreams parses package-agnostic active-contract payloads', () => {
  const streams = extractDiscoveredTokenStandardStreams({
    activeContracts: [
      {
        createdEvent: {
          contractId: 'cid-live-1',
          templateId:
            '7b195e67146bdcecbcbc207aba7b3b605adbb643732c97c15f32a07abd360b2b:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
          createArgument: {
            config: {
              streamId: 'stream-live-1',
              sender: 'Sender::1',
              recipient: 'Recipient::1',
              totalDeposited: '5.0000000000',
              startTime: '2026-04-01T05:59:00.000Z',
              endTime: '2026-04-01T06:15:40.000Z',
              vestingMode: { tag: 'Linear', value: {} },
              assetType: 'GlobalHolding',
              instrumentRef: {
                issuer: 'Registrar::1',
                depository: 'Registrar::1',
                instrumentId: 'CC',
                instrumentVersion: 'testnet',
              },
              cancellable: true,
            },
            state: {
              totalWithdrawn: '0.0000000000',
              status: 'Active',
              renewalCount: 0,
            },
            escrowReference: 'escrow-ref-live-1',
            escrowAmount: '5.0000000000',
            escrowOperator: 'Escrow::1',
            fundingReference: 'holding-1',
            senderAccountRef: '{"party":"Sender::1"}',
            recipientAccountRef: '{"party":"Recipient::1"}',
            lastSettlementReference: { tag: 'None', value: {} },
          },
        },
      },
    ],
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.templateId.includes('TokenStandardEscrow'), true);
  assert.equal(streams[0]?.config.streamId, 'stream-live-1');
  assert.equal(streams[0]?.escrowRef?.escrowOperator, 'Escrow::1');
  assert.equal(streams[0]?.escrowRef?.instrumentRef.instrumentId, 'CC');
});

test('executeInteractiveWithdraw prepares the ledger withdraw before locking wallet funds', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: privateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action')) {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-1',
        expectedPublicKey: 'escrow-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('wallet-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-1',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.2'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: false,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 24,
        recipientPendingPollIntervalMs: 2_500,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    assert.deepEqual(
      calls.map((entry) => entry.url),
      [
        'https://ledger.example/v2/interactive-submission/prepare',
        'https://wallet.example/api/wallet-gateway/prepare-action',
        'https://wallet.example/api/wallet-gateway/execute-action',
        'https://ledger.example/v2/interactive-submission/executeAndWait',
      ],
    );

    const ledgerPrepare = calls[0]?.body;
    const walletPrepare = calls[1]?.body;
    const executeBody = calls[3]?.body;
    const settlementReference =
      ledgerPrepare?.commands?.[0]?.ExerciseCommand?.choiceArgument?.settlementReference;

    assert.match(settlementReference, /^withdraw-stream-1-\d+$/);
    assert.equal(walletPrepare?.requestId, settlementReference);
    assert.equal(walletPrepare?.payload?.memo, settlementReference);
    assert.equal(
      executeBody?.submissionId,
      ledgerPrepare?.commandId,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

// STR-90: when PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER is set, the proxy
// routes the withdraw exercise through the Wallet Gateway's JSON-RPC dApp
// API (listAccounts → prepareExecuteAndWait). The in-process sign +
// /v2/interactive-submission/executeAndWait path MUST NOT be touched.
//
// Note: the deprecated AmuletWalletGatewayAdapter still handles the
// external CC value-transfer leg via /api/wallet-gateway/* — that's a
// separate cutover (STR-86/STR-89/STR-91 collapse this into AllocationRequest).
// STR-90 is strictly about the SIGNING of the Withdraw_TokenStandard
// exercise on the ledger.
test('executeInteractiveWithdraw routes signing through the Wallet Gateway when useSigningProvider=true (STR-90)', async () => {
  const originalFetch = globalThis.fetch;
  const originalAmuletUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalGatewayUrl = process.env.CANTON_STREAMS_SIGNING_GATEWAY_URL;
  const originalGatewayToken = process.env.CANTON_STREAMS_WALLET_GATEWAY_TOKEN;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  __resetSigningResolverForTests();
  // Split the URLs so the amulet adapter's legacy /api/wallet-gateway/ traffic
  // is clearly distinguishable from the SigningProvider's JSON-RPC dApp API.
  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://gateway.example/api/v0/dapp';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_TOKEN = 'gateway-jwt';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: privateKeyPem,
    },
  });

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    // Fail-fast ledger prepare (kept in the SigningProvider branch).
    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    // Deprecated amulet adapter — external CC value-transfer leg.
    if (url.endsWith('/api/wallet-gateway/prepare-action')) {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-1',
        expectedPublicKey: 'escrow-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('wallet-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }
    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: { completionUpdateId: 'wallet-update-1' },
      }), { status: 200 });
    }

    // Gateway JSON-RPC: dispatched by body.method.
    if (url === 'https://gateway.example/api/v0/dapp') {
      const method = body?.method;
      if (method === 'listAccounts') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: [{
            primary: true,
            partyId: 'Escrow::1',
            status: 'allocated',
            hint: 'Escrow',
            publicKey: 'gateway-public-key',
            namespace: '1',
            networkId: 'canton:test',
            signingProviderId: 'participant',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'prepareExecuteAndWait') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tx: {
              status: 'executed',
              commandId: body.params.commandId,
              payload: { updateId: 'gateway-update-1', completionOffset: 42 },
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.2'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: false,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 24,
        recipientPendingPollIntervalMs: 2_500,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
        useSigningProvider: true,
      },
    );

    // 1. Fail-fast prepare ran.
    assert.ok(
      calls.some((c) => c.url === 'https://ledger.example/v2/interactive-submission/prepare'),
      'expected ledger /v2/interactive-submission/prepare for fail-fast',
    );

    // 2. listAccounts went to the gateway JSON-RPC endpoint.
    const listAccountsCall = calls.find(
      (c) => c.url === 'https://gateway.example/api/v0/dapp' && c.body?.method === 'listAccounts',
    );
    assert.ok(listAccountsCall, 'expected a gateway listAccounts JSON-RPC call');

    // 3. prepareExecuteAndWait went to the gateway JSON-RPC endpoint
    //    carrying the Withdraw_TokenStandard exercise as a Command.
    const prepareExecuteCall = calls.find(
      (c) => c.url === 'https://gateway.example/api/v0/dapp' && c.body?.method === 'prepareExecuteAndWait',
    );
    assert.ok(prepareExecuteCall, 'expected a gateway prepareExecuteAndWait JSON-RPC call');
    const command = prepareExecuteCall.body.params.commands[0]?.ExerciseCommand;
    assert.equal(command?.choice, 'Withdraw_TokenStandard');
    assert.deepEqual(prepareExecuteCall.body.params.actAs, ['Escrow::1']);
    assert.equal(prepareExecuteCall.body.params.synchronizerId, 'sync::1');

    // 4. The in-process signing + ledger execute path was NEVER touched.
    const inProcessCall = calls.find(
      (c) => c.url.includes('/v2/interactive-submission/executeAndWait')
          || c.url.endsWith('/v2/interactive-submission/execute'),
    );
    assert.equal(inProcessCall, undefined, 'in-process signing path must not be touched');
  } finally {
    globalThis.fetch = originalFetch;
    __resetSigningResolverForTests();
    void originalGatewayUrl;
    if (originalAmuletUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalAmuletUrl;
    }
    if (originalGatewayToken === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_TOKEN;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw does not double-claim when the transfer adapter already accepted the receiver leg', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
  const originalInstrumentIds = process.env.CANTON_STREAMS_TRANSFER_OFFER_INSTRUMENT_IDS;

  const { privateKey: escrowPrivateKey } = generateKeyPairSync('ed25519');
  const { privateKey: recipientPrivateKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const recipientPrivateKeyPem = recipientPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];
  let pendingTransferReads = 0;
  let transferIssued = false;

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_TRANSFER_OFFER_INSTRUMENT_IDS = 'USDCX';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: recipientPrivateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash-usdcx').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction-usdcx',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.includes('/api/wallet/pending-transfers')) {
      pendingTransferReads += 1;
      if (!transferIssued) {
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        pending: [
          {
            contractId: 'usdcx-offer-1',
            templateId: 'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
            sender: 'Escrow::1',
            receiver: 'Recipient::1',
            amount: '0.6000000000',
            instrument: {
              id: 'USDCx',
              admin: 'Registrar::1',
            },
            requestedAt: '2026-04-01T06:00:00.000Z',
            expired: false,
          },
        ],
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/transfer')) {
      transferIssued = true;
      return new Response(JSON.stringify({
        ok: true,
        transfer: {
          mode: 'cip56_transfer_factory',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action')) {
      return new Response(JSON.stringify({
        sessionId: 'receiver-accept-session-1',
        expectedPublicKey: 'recipient-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('recipient-accept-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'recipient-accept-update-1',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  const stream = activeTokenStandardStream({
    config: {
      recipient: 'Recipient::1',
      streamId: 'stream-usdcx-1',
    },
    escrowRef: {
      escrowOperator: 'Escrow::1',
      instrumentRef: {
        depository: 'Registrar::1',
        issuer: 'Registrar::1',
        instrumentId: 'USDCx',
        instrumentVersion: 'testnet',
      },
    },
  });

  try {
    await executeInteractiveWithdraw(
      {} ,
      stream,
      new Decimal('0.6000000000'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 10_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 4,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: ['Sender::1', 'Recipient::1', 'Escrow::1'],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'service-token',
        serviceUserId: 'streams-service',
      },
      now,
    );

    assert.equal(
      calls.filter((entry) => entry.url.endsWith('/api/wallet-gateway/prepare-action')).length,
      1,
    );
    assert.equal(
      calls.filter((entry) => entry.url.includes('/api/wallet/pending-transfers')).length,
      4,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
    if (originalInstrumentIds === undefined) {
      delete process.env.CANTON_STREAMS_TRANSFER_OFFER_INSTRUMENT_IDS;
    } else {
      process.env.CANTON_STREAMS_TRANSFER_OFFER_INSTRUMENT_IDS = originalInstrumentIds;
    }
  }
});

test('executeInteractiveWithdraw auto-accepts the recipient pending transfer before ledger execute', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey: escrowKey } = generateKeyPairSync('ed25519');
  const { privateKey: recipientKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const recipientPrivateKeyPem = recipientKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];
  let pendingTransferListed = false;

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: recipientPrivateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers')) {
      const token = init?.headers?.authorization ?? init?.headers?.Authorization;
      if (token === 'Bearer recipient-app-token' && pendingTransferListed) {
        return new Response(JSON.stringify({
          pending: [
            {
              contractId: 'pending-transfer-1',
              sender: 'Escrow::1',
              receiver: 'Recipient::1',
              amount: 0.2,
              requestedAt: '2026-04-01T06:00:05.000Z',
              expired: false,
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ pending: [] }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_cc') {
      pendingTransferListed = true;
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-transfer',
        expectedPublicKey: 'escrow-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('wallet-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_accept') {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-accept',
        expectedPublicKey: 'recipient-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('recipient-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-1',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.2'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 2,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    assert.deepEqual(
      calls.map((entry) => entry.url),
      [
        'https://wallet.example/api/wallet/pending-transfers',
        'https://ledger.example/v2/interactive-submission/prepare',
        'https://wallet.example/api/wallet/pending-transfers',
        'https://wallet.example/api/wallet-gateway/prepare-action',
        'https://wallet.example/api/wallet-gateway/execute-action',
        'https://wallet.example/api/wallet/pending-transfers',
        'https://wallet.example/api/wallet-gateway/prepare-action',
        'https://wallet.example/api/wallet-gateway/execute-action',
        'https://ledger.example/v2/interactive-submission/executeAndWait',
      ],
    );

    assert.equal(calls[3]?.body?.action, 'transfer_cc');
    assert.equal(calls[6]?.body?.action, 'transfer_accept');
    assert.equal(calls[6]?.body?.payload?.contractId, 'pending-transfer-1');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw can claim recipient payouts via host-wallet claim API', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey: escrowKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];
  let pendingTransferListed = false;

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: 'recipient-private-key-not-used',
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers')) {
      const token = init?.headers?.authorization ?? init?.headers?.Authorization;
      if (token === 'Bearer recipient-app-token' && pendingTransferListed) {
        return new Response(JSON.stringify({
          pending: [
            {
              contractId: 'pending-transfer-claim-1',
              sender: 'Escrow::1',
              receiver: 'Recipient::1',
              amount: 0.2,
              requestedAt: '2026-04-01T06:00:05.000Z',
              expired: false,
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ pending: [] }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_cc') {
      pendingTransferListed = true;
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-transfer',
        expectedPublicKey: 'escrow-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('wallet-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers/claim')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-claim-1',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.2'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-api-claim',
        recipientPendingPollAttempts: 2,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    assert.deepEqual(
      calls.map((entry) => entry.url),
      [
        'https://wallet.example/api/wallet/pending-transfers',
        'https://ledger.example/v2/interactive-submission/prepare',
        'https://wallet.example/api/wallet/pending-transfers',
        'https://wallet.example/api/wallet-gateway/prepare-action',
        'https://wallet.example/api/wallet-gateway/execute-action',
        'https://wallet.example/api/wallet/pending-transfers',
        'https://wallet.example/api/wallet/pending-transfers/claim',
        'https://ledger.example/v2/interactive-submission/executeAndWait',
      ],
    );

    assert.equal(calls[6]?.body?.contractId, 'pending-transfer-claim-1');
    assert.equal(
      calls.some((entry) => entry.url.endsWith('/api/wallet-gateway/prepare-action') && entry.body?.action === 'transfer_accept'),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw falls back to transfer_accept when host-wallet claim is forbidden', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey: escrowKey } = generateKeyPairSync('ed25519');
  const { privateKey: recipientKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const recipientPrivateKeyPem = recipientKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];
  let pendingTransferListed = false;

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: recipientPrivateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers')) {
      const token = init?.headers?.authorization ?? init?.headers?.Authorization;
      if (token === 'Bearer recipient-app-token' && pendingTransferListed) {
        return new Response(JSON.stringify({
          pending: [
            {
              contractId: 'pending-transfer-fallback-1',
              sender: 'Escrow::1',
              receiver: 'Recipient::1',
              amount: 0.2,
              requestedAt: '2026-04-01T06:00:05.000Z',
              expired: false,
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ pending: [] }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_cc') {
      pendingTransferListed = true;
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-transfer',
        expectedPublicKey: 'escrow-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('wallet-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers/claim')) {
      return new Response(JSON.stringify({
        error: 'Server-side pending-transfer claim is enabled only for scripted users.',
      }), { status: 403 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_accept') {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-accept',
        expectedPublicKey: 'recipient-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('recipient-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-fallback-1',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.2'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-api-claim',
        recipientPendingPollAttempts: 2,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    assert.equal(calls[6]?.url, 'https://wallet.example/api/wallet/pending-transfers/claim');
    assert.equal(calls[7]?.body?.action, 'transfer_accept');
    assert.equal(calls[7]?.body?.payload?.contractId, 'pending-transfer-fallback-1');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw reuses an existing recipient pending transfer before creating a new payout', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey: escrowKey } = generateKeyPairSync('ed25519');
  const { privateKey: recipientKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const recipientPrivateKeyPem = recipientKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: recipientPrivateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers')) {
      return new Response(JSON.stringify({
        pending: [
          {
            contractId: 'pending-transfer-existing',
            sender: 'Escrow::1',
            receiver: 'Recipient::1',
            amount: 0.2,
            requestedAt: '2026-04-01T06:00:05.000Z',
            expired: false,
          },
        ],
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_accept') {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-accept',
        expectedPublicKey: 'recipient-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('recipient-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-existing',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.2'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 2,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    assert.deepEqual(
      calls.map((entry) => entry.url),
      [
        'https://wallet.example/api/wallet/pending-transfers',
        'https://ledger.example/v2/interactive-submission/prepare',
        'https://wallet.example/api/wallet-gateway/prepare-action',
        'https://wallet.example/api/wallet-gateway/execute-action',
        'https://ledger.example/v2/interactive-submission/executeAndWait',
      ],
    );

    assert.equal(
      calls.some((entry) => entry.url.endsWith('/api/wallet-gateway/prepare-action') && entry.body?.action === 'transfer_cc'),
      false,
    );
    assert.equal(calls[2]?.body?.action, 'transfer_accept');
    assert.equal(calls[2]?.body?.payload?.contractId, 'pending-transfer-existing');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw reuses a smaller existing pending transfer before attempting the remaining balance', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey: escrowKey } = generateKeyPairSync('ed25519');
  const { privateKey: recipientKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const recipientPrivateKeyPem = recipientKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: recipientPrivateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers')) {
      return new Response(JSON.stringify({
        pending: [
          {
            contractId: 'pending-transfer-partial',
            sender: 'Escrow::1',
            receiver: 'Recipient::1',
            amount: 0.2,
            requestedAt: '2026-04-01T06:00:05.000Z',
            expired: false,
          },
        ],
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_accept') {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-accept',
        expectedPublicKey: 'recipient-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('recipient-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-partial',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.6'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 2,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    const ledgerPrepare = calls[1]?.body;
    assert.equal(
      ledgerPrepare?.commands?.[0]?.ExerciseCommand?.choiceArgument?.settledAmount,
      '0.2000000000',
    );
    assert.equal(
      ledgerPrepare?.commands?.[0]?.ExerciseCommand?.choiceArgument?.withdrawTime,
      '2026-04-01T05:59:20.000Z',
    );
    assert.equal(
      calls.some((entry) => entry.url.endsWith('/api/wallet-gateway/prepare-action') && entry.body?.action === 'transfer_cc'),
      false,
    );
    assert.equal(calls[2]?.body?.action, 'transfer_accept');
    assert.equal(calls[2]?.body?.payload?.contractId, 'pending-transfer-partial');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw reuses the strongest recoverable pending transfer when several exist', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey: escrowKey } = generateKeyPairSync('ed25519');
  const { privateKey: recipientKey } = generateKeyPairSync('ed25519');
  const escrowPrivateKeyPem = escrowKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const recipientPrivateKeyPem = recipientKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: escrowPrivateKeyPem,
    },
    'Recipient::1': {
      appToken: 'recipient-app-token',
      publicKey: 'recipient-public-key',
      privateKey: recipientPrivateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        preparedTransactionHash: Buffer.from('ledger-prepared-hash').toString('base64'),
        preparedTransaction: 'prepared-ledger-transaction',
        hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet/pending-transfers')) {
      return new Response(JSON.stringify({
        pending: [
          {
            contractId: 'pending-transfer-older',
            sender: 'Escrow::1',
            receiver: 'Recipient::1',
            amount: 0.2,
            requestedAt: '2026-04-01T06:00:05.000Z',
            expired: false,
          },
          {
            contractId: 'pending-transfer-newer-bigger',
            sender: 'Escrow::1',
            receiver: 'Recipient::1',
            amount: 0.3,
            requestedAt: '2026-04-01T06:00:15.000Z',
            expired: false,
          },
        ],
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/prepare-action') && body?.action === 'transfer_accept') {
      return new Response(JSON.stringify({
        sessionId: 'wallet-session-accept',
        expectedPublicKey: 'recipient-public-key',
        prepared: {
          preparedTransactionHash: Buffer.from('recipient-prepared-hash').toString('base64'),
        },
      }), { status: 200 });
    }

    if (url.endsWith('/api/wallet-gateway/execute-action')) {
      return new Response(JSON.stringify({
        externalSigning: {
          completionUpdateId: 'wallet-update-recoverable',
        },
      }), { status: 200 });
    }

    if (url.endsWith('/v2/interactive-submission/executeAndWait')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await executeInteractiveWithdraw(
      {},
      stream,
      new Decimal('0.6'),
      'Escrow::1',
      {
        enabled: true,
        pollIntervalMs: 5_000,
        interactiveEnabled: true,
        recipientAutoAcceptEnabled: true,
        hostWalletAdapter: 'wallet-gateway-transfer-accept',
        recipientPendingPollAttempts: 2,
        recipientPendingPollIntervalMs: 1,
        discoveryParties: [],
        jsonApiUrl: 'https://ledger.example',
        jsonApiToken: 'ledger-token',
        serviceUserId: 'streams-service',
        synchronizerId: 'sync::1',
      },
    );

    assert.equal(
      calls[1]?.body?.commands?.[0]?.ExerciseCommand?.choiceArgument?.settledAmount,
      '0.3000000000',
    );
    assert.equal(calls[2]?.body?.payload?.contractId, 'pending-transfer-newer-bigger');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});

test('executeInteractiveWithdraw does not call wallet-gateway when ledger prepare fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalGatewayUrl = process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
  const originalCredentials = process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;

  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls = [];

  process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = 'https://wallet.example';
  process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = JSON.stringify({
    'Escrow::1': {
      appToken: 'escrow-app-token',
      publicKey: 'escrow-public-key',
      privateKey: privateKeyPem,
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });

    if (url.endsWith('/v2/interactive-submission/prepare')) {
      return new Response(JSON.stringify({
        error: 'Settled amount must match the currently withdrawable amount',
      }), { status: 400 });
    }

    return new Response('unexpected', { status: 500 });
  };

  try {
    const stream = {
      ...activeTokenStandardStream(),
      templateId: 'pkg:CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
    };

    await assert.rejects(
      executeInteractiveWithdraw(
        {},
        stream,
        new Decimal('0.2'),
        'Escrow::1',
        {
          enabled: true,
          pollIntervalMs: 5_000,
          interactiveEnabled: true,
          recipientAutoAcceptEnabled: false,
          hostWalletAdapter: 'wallet-gateway-transfer-accept',
          recipientPendingPollAttempts: 24,
          recipientPendingPollIntervalMs: 2_500,
          discoveryParties: [],
          jsonApiUrl: 'https://ledger.example',
          jsonApiToken: 'ledger-token',
          serviceUserId: 'streams-service',
          synchronizerId: 'sync::1',
        },
      ),
      /interactive-submission\/prepare/i,
    );

    assert.deepEqual(
      calls.map((entry) => entry.url),
      ['https://ledger.example/v2/interactive-submission/prepare'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayUrl === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_URL;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalCredentials === undefined) {
      delete process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON;
    } else {
      process.env.CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON = originalCredentials;
    }
  }
});
