/**
 * AuthProvider tests.
 *
 * Verifies the dapp-sdk-backed auth context:
 *   • starts unauthenticated
 *   • connect() drives isAuthenticated=true with the primary party
 *   • disconnect() clears state
 *   • dev-mode setDevCredentials works when no wallet is connected
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './auth.js';
import type {
  StreamsWalletAccount,
  StreamsWalletConnectResult,
  StreamsWalletStatus,
} from './wallet/types.js';

const mockWalletClient = vi.hoisted(() => ({
  layer: 'dapp-sdk',
  name: 'Mock wallet',
  supportsHostedMultiWallet: false,
  capabilities: {
    ledgerApi: true,
    prepareExecuteAndWait: true,
    v2AllocationRequestUx: true,
    hostedMultiWallet: false,
    openSurfacesWalletUi: true,
  },
  init: vi.fn(),
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listAccounts: vi.fn(),
  open: vi.fn(),
  ledgerApi: vi.fn(),
  prepareExecuteAndWait: vi.fn(),
  describeConnectError: vi.fn(),
  onStatusChanged: vi.fn(),
  onAccountsChanged: vi.fn(),
  onConnected: vi.fn(),
  onTxChanged: vi.fn(),
  removeOnStatusChanged: vi.fn(),
  removeOnAccountsChanged: vi.fn(),
  removeOnConnected: vi.fn(),
  removeOnTxChanged: vi.fn(),
}));

vi.mock('./wallet/index.js', () => ({
  walletClient: mockWalletClient,
  WALLET_LAYER: 'dapp-sdk',
}));

// Restore each mock to a clean default before every test so previous
// `mockResolvedValue(...)` overrides don't leak into the next case.
beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* incognito */
  }
  mockWalletClient.init.mockReset().mockResolvedValue(undefined);
  mockWalletClient.status.mockReset().mockResolvedValue({
    provider: { id: 'mock-provider' },
    connection: { isConnected: false, isNetworkConnected: false },
  });
  mockWalletClient.connect.mockReset().mockResolvedValue({
    isConnected: false,
    isNetworkConnected: false,
  });
  mockWalletClient.disconnect.mockReset().mockResolvedValue(undefined);
  mockWalletClient.listAccounts.mockReset().mockResolvedValue([]);
  mockWalletClient.describeConnectError
    .mockReset()
    .mockImplementation(async (err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
  for (const name of [
    'onStatusChanged',
    'onAccountsChanged',
    'onConnected',
    'onTxChanged',
    'removeOnStatusChanged',
    'removeOnAccountsChanged',
    'removeOnConnected',
    'removeOnTxChanged',
  ] as const) {
    mockWalletClient[name].mockReset().mockResolvedValue(undefined);
  }
});

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="party">{auth.party ?? 'none'}</div>
      <div data-testid="token">{auth.token ?? 'none'}</div>
      <div data-testid="auth">{String(auth.isAuthenticated)}</div>
      <div data-testid="devMode">{String(auth.devMode)}</div>
      <button onClick={() => auth.connect()}>connect</button>
      <button onClick={() => auth.disconnect()}>disconnect</button>
      <button
        onClick={() => auth.setDevCredentials('dev-token', 'alice::dev')}
      >
        devLogin
      </button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('starts unauthenticated', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('auth')).toHaveTextContent('false');
    });
    expect(screen.getByTestId('party')).toHaveTextContent('none');
  });

  it('connect() pulls the primary party from sdk.listAccounts', async () => {
    // Use unknown-cast so the test fixture doesn't have to mirror the
    // entire SDK WalletStatus enum shape — we only exercise the fields
    // auth.tsx reads (`primary`, `partyId`, `signingProviderId`).
    const wallets: StreamsWalletAccount[] = [
      {
        primary: true,
        partyId: 'alice::1220',
        signingProviderId: 'wallet-gateway-internal',
      },
    ];
    const connectResult: StreamsWalletConnectResult = {
      isConnected: true,
      isNetworkConnected: true,
    };
    const statusEvent: StreamsWalletStatus = {
      provider: { id: 'mock-provider' },
      connection: connectResult,
      network: {
        networkId: 'canton:test',
        accessToken: 'wallet-access-token',
      },
      session: { accessToken: 'wallet-access-token', userId: 'u1' },
    };
    // Use plain `mockResolvedValue` (not `Once`) — AuthProvider's cold-start
    // effect calls `status()` before the click, and the click calls it
    // again. Both calls need to return the connected snapshot.
    mockWalletClient.connect.mockResolvedValue(connectResult);
    mockWalletClient.status.mockResolvedValue(statusEvent);
    mockWalletClient.listAccounts.mockResolvedValue(wallets);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByText('connect'));

    await waitFor(() => {
      expect(screen.getByTestId('auth')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('party')).toHaveTextContent('alice::1220');
    expect(screen.getByTestId('token')).toHaveTextContent(
      'wallet-access-token',
    );
    expect(screen.getByTestId('devMode')).toHaveTextContent('false');
  });

  it('disconnect() clears the session', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await userEvent.click(screen.getByText('devLogin'));
    });
    expect(screen.getByTestId('auth')).toHaveTextContent('true');
    expect(screen.getByTestId('devMode')).toHaveTextContent('true');

    await userEvent.click(screen.getByText('disconnect'));
    await waitFor(() => {
      expect(screen.getByTestId('auth')).toHaveTextContent('false');
    });
  });

  it('setDevCredentials authenticates without a wallet', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await userEvent.click(screen.getByText('devLogin'));
    await waitFor(() => {
      expect(screen.getByTestId('auth')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('party')).toHaveTextContent('alice::dev');
    expect(screen.getByTestId('token')).toHaveTextContent('dev-token');
    expect(screen.getByTestId('devMode')).toHaveTextContent('true');
  });
});
