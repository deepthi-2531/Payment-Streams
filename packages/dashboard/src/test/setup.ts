/**
 * Vitest global setup.
 *
 * • Attaches jest-dom matchers so component tests can use `.toBeInTheDocument()` etc.
 * • Boots an msw server with the dashboard's REST handlers so any test that
 *   reaches the TanStack hooks gets a deterministic proxy response.
 * • Mocks `@canton-network/dapp-sdk` so the AuthProvider can mount without
 *   trying to open a real wallet picker in jsdom.
 */

import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './handlers/index.js';

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// JSDOM doesn't ship crypto.randomUUID until Node 19+; tests run on Node 22+ but
// safety-net here keeps `crypto.randomUUID()` deterministic between tests.
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  let counter = 0;
  globalThis.crypto = (globalThis.crypto ?? {}) as Crypto;
  Object.assign(globalThis.crypto, {
    randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
}

// Vitest's vi.mock hoist requires the factory to be inline. We stub the
// minimal surface AuthProvider touches: `init`, `status`, `listAccounts`,
// `connect`, `disconnect`, plus the four event subscribers it wires.
vi.mock('@canton-network/dapp-sdk', () => {
  const dappSDK = {
    init: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({
      provider: { id: 'mock-provider' },
      connection: { isConnected: false, isNetworkConnected: false },
    }),
    connect: vi.fn().mockResolvedValue({
      isConnected: true,
      isNetworkConnected: true,
    }),
    disconnect: vi.fn().mockResolvedValue(null),
    listAccounts: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue(undefined),
    ledgerApi: vi.fn().mockResolvedValue({ response: '{}' }),
    prepareExecuteAndWait: vi.fn().mockResolvedValue({ updateId: 'mock-update' }),
    onStatusChanged: vi.fn().mockResolvedValue(undefined),
    onAccountsChanged: vi.fn().mockResolvedValue(undefined),
    onConnected: vi.fn().mockResolvedValue(undefined),
    onTxChanged: vi.fn().mockResolvedValue(undefined),
    removeOnStatusChanged: vi.fn().mockResolvedValue(undefined),
    removeOnAccountsChanged: vi.fn().mockResolvedValue(undefined),
    removeOnConnected: vi.fn().mockResolvedValue(undefined),
    removeOnTxChanged: vi.fn().mockResolvedValue(undefined),
  };
  class RemoteAdapter {
    readonly providerId: string;
    readonly name: string;
    readonly type = 'remote';
    readonly rpcUrl: string;

    constructor(config: { providerId?: string; name: string; rpcUrl: string }) {
      this.providerId = config.providerId ?? `remote:${config.rpcUrl}`;
      this.name = config.name;
      this.rpcUrl = config.rpcUrl;
    }

    async detect() {
      return true;
    }

    getInfo() {
      return {
        providerId: this.providerId,
        name: this.name,
        type: this.type,
        url: this.rpcUrl,
      };
    }
  }

  class DappSDK {
    constructor() {
      return dappSDK;
    }
  }

  return { dappSDK, DappSDK, RemoteAdapter };
});
