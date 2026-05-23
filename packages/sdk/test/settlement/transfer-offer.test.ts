import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { TransferOfferAdapter } from '../../src/settlement/adapters/transfer-offer.js';

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

describe('TransferOfferAdapter', () => {
  it('handles configured DA Utility instruments by default', async () => {
    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      credentials: {},
      fetchImpl: vi.fn() as any,
    });

    await expect(adapter.canHandle('decentralized-usdc::1220admin', 'USDCx')).resolves.toBe(true);
    await expect(adapter.canHandle('bitsafe::1220admin', 'CBTC')).resolves.toBe(true);
    await expect(adapter.canHandle('registrar::1220admin', 'BIT')).resolves.toBe(false);
  });

  it('creates a hosted transfer, accepts the pending offer, and returns the receiver acceptance reference', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const preparedTransactionHash = Buffer.from('receiver-accept-hash').toString('base64');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      if (pathname === '/api/wallet/pending-transfers' && body === null) {
        const callIndex = fetchImpl.mock.calls.length;
        if (callIndex <= 1) {
          return new Response(JSON.stringify({ pending: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          pending: [
            {
              contractId: 'offer-1',
              templateId:
                'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
              sender: 'Sender::1220aaa',
              receiver: 'Escrow::1220bbb',
              amount: '1.0000000000',
              instrument: {
                id: 'USDCx',
                admin: 'Registrar::1220admin',
              },
              requestedAt: '2026-04-03T12:00:00.000Z',
              expired: false,
            },
          ],
        }), { status: 200 });
      }

      if (pathname === '/api/wallet/transfer') {
        return new Response(JSON.stringify({
          ok: true,
          transfer: {
            mode: 'cip56_transfer_factory',
          },
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/prepare-action') {
        return new Response(JSON.stringify({
          sessionId: 'accept-session-1',
          expectedPublicKey: 'receiver-public-key',
          prepared: {
            preparedTransactionHash,
          },
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/execute-action') {
        return new Response(JSON.stringify({
          externalSigning: {
            completionUpdateId: 'receiver-accept-update-1',
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    });

    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      pendingPollAttempts: 2,
      pendingPollIntervalMs: 1,
      credentials: {
        'Sender::1220aaa': {
          appToken: 'sender-app-token',
        },
        'Escrow::1220bbb': {
          appToken: 'receiver-app-token',
          publicKey: 'receiver-public-key',
          privateKey: privateKeyPem,
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Sender::1220aaa',
        to: 'Escrow::1220bbb',
        amount: new Decimal('1'),
        registrar: 'Registrar::1220admin',
        instrumentId: 'USDCx',
        reference: 'finalize-usdcx-stream-1',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'receiver-accept-update-1',
      amount: new Decimal('1'),
      receiverAccepted: true,
      pendingTransferContractId: 'offer-1',
    });

    const transferCall = fetchImpl.mock.calls.find((call) =>
      new URL(String(call[0])).pathname === '/api/wallet/transfer',
    );
    expect(transferCall).toBeTruthy();
    expect(JSON.parse(String(transferCall?.[1]?.body))).toEqual({
      party: 'Sender::1220aaa',
      toParty: 'Escrow::1220bbb',
      symbol: 'USDCx',
      instrumentId: 'USDCx',
      instrumentAdmin: 'Registrar::1220admin',
      amount: '1.0000000000',
      memo: 'finalize-usdcx-stream-1',
      cip56FallbackEnabled: true,
    });

    const acceptPrepareCall = fetchImpl.mock.calls.find((call) =>
      new URL(String(call[0])).pathname === '/api/wallet-gateway/prepare-action',
    );
    expect(JSON.parse(String(acceptPrepareCall?.[1]?.body))).toEqual({
      action: 'transfer_accept',
      party: 'Escrow::1220bbb',
      requestId: expect.any(String),
      payload: {
        contractId: 'offer-1',
        templateId: 'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
        instrumentId: 'USDCx',
        instrumentAdmin: 'Registrar::1220admin',
      },
    });
  });

  it('falls back to a direct settlement reference when the host app completes the transfer without a pending accept step', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/wallet/pending-transfers') {
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }
      if (pathname === '/api/wallet/transfer') {
        return new Response(JSON.stringify({
          transfer: {
            settlement: {
              completion: {
                updateId: 'direct-completion-1',
              },
            },
          },
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      pendingPollAttempts: 1,
      credentials: {
        'Sender::1220aaa': {
          appToken: 'sender-app-token',
        },
        'Receiver::1220bbb': {
          appToken: 'receiver-app-token',
          publicKey: 'receiver-public-key',
          privateKey: 'LS0tLQ==',
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Sender::1220aaa',
        to: 'Receiver::1220bbb',
        amount: new Decimal('0.5'),
        registrar: 'Registrar::1220admin',
        instrumentId: 'USDCx',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'direct-completion-1',
      amount: new Decimal('0.5'),
      receiverAccepted: true,
    });
  });

  it('falls back to the hosted wallet transfer when sender-side interactive transfer cannot find holdings', async () => {
    const { privateKey: senderKey } = generateKeyPairSync('ed25519');
    const { privateKey: receiverKey } = generateKeyPairSync('ed25519');
    const senderPrivateKeyPem = senderKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const receiverPrivateKeyPem = receiverKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;

      if (pathname === '/api/wallet/pending-transfers') {
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }

      if (pathname === '/v2/state/ledger-end') {
        return new Response(JSON.stringify({ offset: 987 }), { status: 200 });
      }

      if (pathname === '/v2/state/active-contracts') {
        return new Response(JSON.stringify({ activeContracts: [] }), { status: 200 });
      }

      if (pathname === '/api/wallet/transfer') {
        return new Response(JSON.stringify({
          transfer: {
            settlement: {
              completion: {
                updateId: 'hosted-fallback-completion-1',
              },
            },
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    });

    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      jsonApiUrl: 'https://ledger.example',
      ledgerToken: 'ledger-token',
      ledgerUserId: 'ledger-api-user',
      synchronizerId: 'sync::1',
      registryApiBase: 'https://registry.example',
      pendingPollAttempts: 1,
      credentials: {
        'Sender::1220aaa': {
          appToken: 'sender-app-token',
          publicKey: 'sender-public-key',
          privateKey: senderPrivateKeyPem,
        },
        'Receiver::1220bbb': {
          appToken: 'receiver-app-token',
          publicKey: 'receiver-public-key',
          privateKey: receiverPrivateKeyPem,
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Sender::1220aaa',
        to: 'Receiver::1220bbb',
        amount: new Decimal('0.5'),
        registrar: 'Registrar::1220admin',
        instrumentId: 'USDCx',
        reference: 'interactive-fallback-usdcx-1',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'hosted-fallback-completion-1',
      amount: new Decimal('0.5'),
      receiverAccepted: true,
    });

    expect(
      fetchImpl.mock.calls.some((call) =>
        new URL(String(call[0])).pathname === '/v2/state/active-contracts',
      ),
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.some((call) =>
        new URL(String(call[0])).pathname === '/api/wallet/transfer',
      ),
    ).toBe(true);
  });

  it('uses interactive TransferFactory submit for sender-side hybrid signers', async () => {
    const { privateKey: senderKey } = generateKeyPairSync('ed25519');
    const { privateKey: receiverKey } = generateKeyPairSync('ed25519');
    const senderPrivateKeyPem = senderKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const receiverPrivateKeyPem = receiverKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      if (pathname === '/api/wallet/pending-transfers' && body === null) {
        const token = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (token === 'Bearer receiver-app-token' && fetchImpl.mock.calls.length >= 6) {
          return new Response(JSON.stringify({
            pending: [
              {
                contractId: 'offer-interactive-1',
                templateId:
                  'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
                sender: 'Sender::1220aaa',
                receiver: 'Escrow::1220bbb',
                amount: '0.5000000000',
                instrument: {
                  id: 'USDCx',
                  admin: 'Registrar::1220admin',
                },
                requestedAt: '2026-04-03T12:10:00.000Z',
                expired: false,
              },
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }

      if (pathname === '/v2/state/ledger-end') {
        return new Response(JSON.stringify({ offset: 123 }), { status: 200 });
      }

      if (pathname === '/v2/state/active-contracts') {
        return new Response(JSON.stringify({
          activeContracts: [
            {
              contractEntry: {
                JsActiveContract: {
                  createdEvent: {
                    contractId: 'holding-1',
                    templateId: 'pkg:Utility.Registry.Holding.V0.Holding:Holding',
                    createArgument: {
                      owner: 'Sender::1220aaa',
                      amount: '1.0000000000',
                      instrument: {
                        id: 'USDCx',
                        admin: 'Registrar::1220admin',
                      },
                    },
                  },
                },
              },
            },
          ],
        }), { status: 200 });
      }

      if (pathname === '/registrars/Registrar%3A%3A1220admin/registry/transfer-instruction/v1/transfer-factory') {
        return new Response(JSON.stringify({
          factoryId: 'factory-1',
          choiceContextData: {
            'utility.digitalasset.com/transfer-rule': 'rule-1',
          },
          disclosedContracts: [
            {
              contractId: 'rule-1',
              synchronizerId: 'sync::1',
            },
          ],
          synchronizerId: 'sync::1',
        }), { status: 200 });
      }

      if (pathname === '/v2/interactive-submission/prepare') {
        return new Response(JSON.stringify({
          preparedTransactionHash: Buffer.from('sender-transfer-hash').toString('base64'),
          preparedTransaction: 'prepared-transfer-command',
          hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
          deduplicationPeriod: { Empty: {} },
        }), { status: 200 });
      }

      if (pathname === '/v2/interactive-submission/executeAndWait') {
        return new Response(JSON.stringify({
          updateId: 'transfer-update-1',
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/prepare-action') {
        return new Response(JSON.stringify({
          sessionId: 'accept-session-2',
          expectedPublicKey: 'receiver-public-key',
          prepared: {
            preparedTransactionHash: Buffer.from('receiver-accept-hash').toString('base64'),
          },
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/execute-action') {
        return new Response(JSON.stringify({
          externalSigning: {
            completionUpdateId: 'receiver-accept-update-2',
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    });

    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      jsonApiUrl: 'https://ledger.example',
      ledgerToken: 'ledger-token',
      ledgerUserId: 'ledger-api-user',
      synchronizerId: 'sync::1',
      registryApiBase: 'https://registry.example',
      pendingPollAttempts: 2,
      pendingPollIntervalMs: 1,
      credentials: {
        'Sender::1220aaa': {
          appToken: 'sender-app-token',
          publicKey: 'sender-public-key',
          privateKey: senderPrivateKeyPem,
        },
        'Escrow::1220bbb': {
          appToken: 'receiver-app-token',
          publicKey: 'receiver-public-key',
          privateKey: receiverPrivateKeyPem,
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Sender::1220aaa',
        to: 'Escrow::1220bbb',
        amount: new Decimal('0.5'),
        registrar: 'Registrar::1220admin',
        instrumentId: 'USDCx',
        reference: 'interactive-usdcx-stream-1',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'receiver-accept-update-2',
      amount: new Decimal('0.5'),
      receiverAccepted: true,
      pendingTransferContractId: 'offer-interactive-1',
    });

    expect(
      fetchImpl.mock.calls.some((call) =>
        new URL(String(call[0])).pathname === '/api/wallet/transfer',
      ),
    ).toBe(false);

    const registryCall = fetchImpl.mock.calls.find((call) =>
      new URL(String(call[0])).pathname === '/registrars/Registrar%3A%3A1220admin/registry/transfer-instruction/v1/transfer-factory',
    );
    expect(registryCall).toBeTruthy();
    expect(JSON.parse(String(registryCall?.[1]?.body))).toMatchObject({
      choiceArguments: {
        expectedAdmin: 'Registrar::1220admin',
        transfer: {
          sender: 'Sender::1220aaa',
          receiver: 'Escrow::1220bbb',
          amount: '0.5000000000',
          instrumentId: {
            id: 'USDCx',
            admin: 'Registrar::1220admin',
          },
          inputHoldingCids: ['holding-1'],
        },
        extraArgs: {
          context: { values: {} },
        },
      },
      excludeDebugFields: false,
    });

    const prepareCall = fetchImpl.mock.calls.find((call) =>
      new URL(String(call[0])).pathname === '/v2/interactive-submission/prepare',
    );
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body));
    expect(prepareBody.synchronizerId).toBe('sync::1');
    expect(prepareBody.commands[0].ExerciseCommand.templateId).toBe(
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
    );
    expect(prepareBody.commands[0].ExerciseCommand.choice).toBe('TransferFactory_Transfer');
    expect(prepareBody.commands[0].ExerciseCommand.choiceArgument.extraArgs.context).toEqual({
      'utility.digitalasset.com/transfer-rule': 'rule-1',
    });
  });

  it('treats instrument source as the registrar when selecting sender holdings', async () => {
    const { privateKey: senderKey } = generateKeyPairSync('ed25519');
    const { privateKey: receiverKey } = generateKeyPairSync('ed25519');
    const senderPrivateKeyPem = senderKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const receiverPrivateKeyPem = receiverKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      if (pathname === '/api/wallet/pending-transfers' && body === null) {
        const token = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (token === 'Bearer receiver-app-token' && fetchImpl.mock.calls.length >= 6) {
          return new Response(JSON.stringify({
            pending: [
              {
                contractId: 'offer-source-1',
                templateId:
                  'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
                sender: 'Sender::1220aaa',
                receiver: 'Escrow::1220bbb',
                amount: '0.5000000000',
                instrument: {
                  id: 'USDCx',
                  admin: 'Registrar::1220admin',
                },
                requestedAt: '2026-04-03T12:20:00.000Z',
                expired: false,
              },
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }

      if (pathname === '/v2/state/ledger-end') {
        return new Response(JSON.stringify({ offset: 456 }), { status: 200 });
      }

      if (pathname === '/v2/state/active-contracts') {
        return new Response(JSON.stringify({
          activeContracts: [
            {
              contractEntry: {
                JsActiveContract: {
                  createdEvent: {
                    contractId: 'holding-source-1',
                    templateId: 'pkg:Utility.Registry.Holding.V0.Holding:Holding',
                    createArgument: {
                      owner: 'Sender::1220aaa',
                      amount: '1.0000000000',
                      instrument: {
                        id: 'USDCx',
                        source: 'Registrar::1220admin',
                      },
                    },
                  },
                },
              },
            },
          ],
        }), { status: 200 });
      }

      if (pathname === '/registrars/Registrar%3A%3A1220admin/registry/transfer-instruction/v1/transfer-factory') {
        return new Response(JSON.stringify({
          factoryId: 'factory-source-1',
          choiceContextData: {
            'utility.digitalasset.com/transfer-rule': 'rule-source-1',
          },
          disclosedContracts: [
            {
              contractId: 'rule-source-1',
              synchronizerId: 'sync::1',
            },
          ],
          synchronizerId: 'sync::1',
        }), { status: 200 });
      }

      if (pathname === '/v2/interactive-submission/prepare') {
        return new Response(JSON.stringify({
          preparedTransactionHash: Buffer.from('sender-transfer-source-hash').toString('base64'),
          preparedTransaction: 'prepared-transfer-source-command',
          hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
          deduplicationPeriod: { Empty: {} },
        }), { status: 200 });
      }

      if (pathname === '/v2/interactive-submission/executeAndWait') {
        return new Response(JSON.stringify({
          updateId: 'transfer-source-update-1',
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/prepare-action') {
        return new Response(JSON.stringify({
          sessionId: 'accept-session-source-1',
          expectedPublicKey: 'receiver-public-key',
          prepared: {
            preparedTransactionHash: Buffer.from('receiver-accept-source-hash').toString('base64'),
          },
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/execute-action') {
        return new Response(JSON.stringify({
          externalSigning: {
            completionUpdateId: 'receiver-source-accept-update-1',
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    });

    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      jsonApiUrl: 'https://ledger.example',
      ledgerToken: 'ledger-token',
      ledgerUserId: 'ledger-api-user',
      synchronizerId: 'sync::1',
      registryApiBase: 'https://registry.example',
      pendingPollAttempts: 2,
      pendingPollIntervalMs: 1,
      credentials: {
        'Sender::1220aaa': {
          appToken: 'sender-app-token',
          publicKey: 'sender-public-key',
          privateKey: senderPrivateKeyPem,
        },
        'Escrow::1220bbb': {
          appToken: 'receiver-app-token',
          publicKey: 'receiver-public-key',
          privateKey: receiverPrivateKeyPem,
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Sender::1220aaa',
        to: 'Escrow::1220bbb',
        amount: new Decimal('0.5'),
        registrar: 'Registrar::1220admin',
        instrumentId: 'USDCx',
        reference: 'interactive-usdcx-source-1',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'receiver-source-accept-update-1',
      amount: new Decimal('0.5'),
      receiverAccepted: true,
      pendingTransferContractId: 'offer-source-1',
    });

    const registryCall = fetchImpl.mock.calls.find((call) =>
      new URL(String(call[0])).pathname === '/registrars/Registrar%3A%3A1220admin/registry/transfer-instruction/v1/transfer-factory',
    );
    expect(registryCall).toBeTruthy();
    expect(JSON.parse(String(registryCall?.[1]?.body))).toMatchObject({
      choiceArguments: {
        transfer: {
          inputHoldingCids: ['holding-source-1'],
        },
      },
      excludeDebugFields: false,
    });
  });

  it('falls back to the raw registry choice argument when the wrapped request is rejected', async () => {
    const { privateKey: senderKey } = generateKeyPairSync('ed25519');
    const { privateKey: receiverKey } = generateKeyPairSync('ed25519');
    const senderPrivateKeyPem = senderKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const receiverPrivateKeyPem = receiverKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    let registryCallCount = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      if (pathname === '/api/wallet/pending-transfers' && body === null) {
        const token = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (token === 'Bearer receiver-app-token' && fetchImpl.mock.calls.length >= 7) {
          return new Response(JSON.stringify({
            pending: [
              {
                contractId: 'offer-fallback-1',
                templateId:
                  'pkg:Utility.Registry.App.V0.Model.Transfer:TransferOffer',
                sender: 'Sender::1220aaa',
                receiver: 'Escrow::1220bbb',
                amount: '0.5000000000',
                instrument: {
                  id: 'USDCx',
                  admin: 'Registrar::1220admin',
                },
                requestedAt: '2026-04-03T12:30:00.000Z',
                expired: false,
              },
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ pending: [] }), { status: 200 });
      }

      if (pathname === '/v2/state/ledger-end') {
        return new Response(JSON.stringify({ offset: 789 }), { status: 200 });
      }

      if (pathname === '/v2/state/active-contracts') {
        return new Response(JSON.stringify({
          activeContracts: [
            {
              contractEntry: {
                JsActiveContract: {
                  createdEvent: {
                    contractId: 'holding-fallback-1',
                    templateId: 'pkg:Utility.Registry.Holding.V0.Holding:Holding',
                    createArgument: {
                      owner: 'Sender::1220aaa',
                      amount: '1.0000000000',
                      instrument: {
                        id: 'USDCx',
                        source: 'Registrar::1220admin',
                      },
                    },
                  },
                },
              },
            },
          ],
        }), { status: 200 });
      }

      if (pathname === '/registrars/Registrar%3A%3A1220admin/registry/transfer-instruction/v1/transfer-factory') {
        registryCallCount += 1;
        if (registryCallCount === 1) {
          return new Response(JSON.stringify({
            error: 'Missing required field: DownField(choiceArguments)',
          }), { status: 422 });
        }
        return new Response(JSON.stringify({
          factoryId: 'factory-fallback-1',
          choiceContext: {
            choiceContextData: {
              'utility.digitalasset.com/transfer-rule': 'rule-fallback-1',
            },
            disclosedContracts: [
              {
                contractId: 'rule-fallback-1',
                synchronizerId: 'sync::1',
              },
            ],
          },
        }), { status: 200 });
      }

      if (pathname === '/v2/interactive-submission/prepare') {
        return new Response(JSON.stringify({
          preparedTransactionHash: Buffer.from('sender-transfer-fallback-hash').toString('base64'),
          preparedTransaction: 'prepared-transfer-fallback-command',
          hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2',
          deduplicationPeriod: { Empty: {} },
        }), { status: 200 });
      }

      if (pathname === '/v2/interactive-submission/executeAndWait') {
        return new Response(JSON.stringify({
          updateId: 'transfer-fallback-update-1',
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/prepare-action') {
        return new Response(JSON.stringify({
          sessionId: 'accept-session-fallback-1',
          expectedPublicKey: 'receiver-public-key',
          prepared: {
            preparedTransactionHash: Buffer.from('receiver-accept-fallback-hash').toString('base64'),
          },
        }), { status: 200 });
      }

      if (pathname === '/api/wallet-gateway/execute-action') {
        return new Response(JSON.stringify({
          externalSigning: {
            completionUpdateId: 'receiver-fallback-accept-update-1',
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    });

    const adapter = new TransferOfferAdapter({
      baseUrl: 'https://wallet.example',
      jsonApiUrl: 'https://ledger.example',
      ledgerToken: 'ledger-token',
      ledgerUserId: 'ledger-api-user',
      synchronizerId: 'sync::1',
      registryApiBase: 'https://registry.example',
      pendingPollAttempts: 2,
      pendingPollIntervalMs: 1,
      credentials: {
        'Sender::1220aaa': {
          appToken: 'sender-app-token',
          publicKey: 'sender-public-key',
          privateKey: senderPrivateKeyPem,
        },
        'Escrow::1220bbb': {
          appToken: 'receiver-app-token',
          publicKey: 'receiver-public-key',
          privateKey: receiverPrivateKeyPem,
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Sender::1220aaa',
        to: 'Escrow::1220bbb',
        amount: new Decimal('0.5'),
        registrar: 'Registrar::1220admin',
        instrumentId: 'USDCx',
        reference: 'interactive-usdcx-fallback-1',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'receiver-fallback-accept-update-1',
      amount: new Decimal('0.5'),
      receiverAccepted: true,
      pendingTransferContractId: 'offer-fallback-1',
    });

    expect(registryCallCount).toBe(2);
    const registryCalls = fetchImpl.mock.calls.filter((call) =>
      new URL(String(call[0])).pathname === '/registrars/Registrar%3A%3A1220admin/registry/transfer-instruction/v1/transfer-factory',
    );
    expect(JSON.parse(String(registryCalls[0]?.[1]?.body))).toMatchObject({
      choiceArguments: {
        transfer: {
          inputHoldingCids: ['holding-fallback-1'],
        },
      },
      excludeDebugFields: false,
    });
    expect(JSON.parse(String(registryCalls[1]?.[1]?.body))).toMatchObject({
      expectedAdmin: 'Registrar::1220admin',
      transfer: {
        inputHoldingCids: ['holding-fallback-1'],
      },
    });
  });
});
