import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { AmuletWalletGatewayAdapter } from '../../src/settlement/adapters/amulet.js';

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

describe('AmuletWalletGatewayAdapter', () => {
  it('handles CC and Amulet instruments', async () => {
    const adapter = new AmuletWalletGatewayAdapter({
      baseUrl: 'https://wallet.example',
      credentials: {},
      fetchImpl: vi.fn() as any,
    });

    await expect(adapter.canHandle('registrar', 'CC')).resolves.toBe(true);
    await expect(adapter.canHandle('registrar', 'Amulet')).resolves.toBe(true);
    await expect(adapter.canHandle('registrar', 'CBTC')).resolves.toBe(false);
  });

  it('executes transfer_cc through the hosted wallet gateway', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    // Raw 32-byte Ed25519 public key derived from the same key, base64-encoded —
    // must match what the signer derives, since the loader now verifies the pair.
    const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const publicKeyBase64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
    const preparedTransactionHash = Buffer.from('prepared-transaction-hash').toString('base64');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/prepare-action')) {
        return new Response(JSON.stringify({
          sessionId: 'session-123',
          expectedPublicKey: publicKeyBase64,
          prepared: {
            preparedTransactionHash,
          },
        }), { status: 200 });
      }

      if (pathname.endsWith('/execute-action')) {
        return new Response(JSON.stringify({
          externalSigning: {
            completionUpdateId: 'update-123',
          },
        }), { status: 200 });
      }

      return new Response('not found', { status: 404 });
    });

    const adapter = new AmuletWalletGatewayAdapter({
      baseUrl: 'https://wallet.example',
      credentials: {
        'Escrow::1220abc': {
          appToken: 'escrow-app-token',
          publicKey: publicKeyBase64,
          privateKey: privateKeyPem,
        },
      },
      fetchImpl: fetchImpl as any,
    });

    const result = await adapter.transfer(
      {
        from: 'Escrow::1220abc',
        to: 'Receiver::1220def',
        amount: new Decimal('0.1'),
        registrar: 'example-registrar::1220reg',
        instrumentId: 'CC',
        reference: 'withdraw-stream-1',
      },
      [],
      {} as any,
      logger,
    );

    expect(result).toEqual({
      settlementReference: 'update-123',
      amount: new Decimal('0.1'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://wallet.example/api/wallet-gateway/prepare-action');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://wallet.example/api/wallet-gateway/execute-action');

    const prepareBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(prepareBody).toEqual({
      action: 'transfer_cc',
      party: 'Escrow::1220abc',
      requestId: 'withdraw-stream-1',
      payload: {
        toParty: 'Receiver::1220def',
        amount: '0.1000000000',
        memo: 'withdraw-stream-1',
      },
    });

    const executeBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(executeBody.party).toBe('Escrow::1220abc');
    expect(executeBody.sessionId).toBe('session-123');
    expect(executeBody.publicKey).toBe(publicKeyBase64);
    expect(typeof executeBody.signature).toBe('string');
    expect(executeBody.signature.length).toBeGreaterThan(10);
  });

  it('fails with a clear error when the sending party has no configured signer', async () => {
    const adapter = new AmuletWalletGatewayAdapter({
      baseUrl: 'https://wallet.example',
      credentials: {},
      fetchImpl: vi.fn() as any,
    });

    await expect(
      adapter.transfer(
        {
          from: 'Escrow::missing',
          to: 'Receiver::1220def',
          amount: new Decimal('1'),
          registrar: 'example-registrar::1220reg',
          instrumentId: 'CC',
        },
        [],
        {} as any,
        logger,
      ),
    ).rejects.toThrow('No wallet-gateway signer configured for party Escrow::missing');
  });
});
