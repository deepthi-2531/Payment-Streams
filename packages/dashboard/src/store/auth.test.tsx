/**
 * AuthProvider — Phase 8 / STR-119.
 *
 * Verifies the dapp-sdk-backed auth context:
 *   • starts unauthenticated
 *   • connect() drives isAuthenticated=true with the primary party
 *   • disconnect() clears state
 *   • dev-mode setDevCredentials works when no wallet is connected
 */

import type { vi } from 'vitest';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  dappSDK,
  type Wallet,
  type ConnectResult,
  type StatusEvent,
} from '@canton-network/dapp-sdk';
import { AuthProvider, useAuth } from './auth.js';

// Restore each mock to a clean default before every test so previous
// `mockResolvedValue(...)` overrides don't leak into the next case.
beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* incognito */
  }
  (dappSDK.init as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(
    undefined,
  );
  (dappSDK.status as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({
    provider: { id: 'mock-provider' },
    connection: { isConnected: false, isNetworkConnected: false },
  });
  (dappSDK.connect as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({
    isConnected: false,
    isNetworkConnected: false,
  });
  (dappSDK.disconnect as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockResolvedValue(null);
  (dappSDK.listAccounts as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockResolvedValue([]);
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
    (dappSDK[name] as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValue(undefined);
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
    const wallets: Wallet[] = [
      ({
        primary: true,
        partyId: 'alice::1220',
        status: 'connected',
        hint: 'alice',
        publicKey: 'pk',
        namespace: '1220',
        networkId: 'canton:test',
        signingProviderId: 'wallet-gateway-internal',
      } as unknown) as Wallet,
    ];
    const connectResult: ConnectResult = {
      isConnected: true,
      isNetworkConnected: true,
    };
    const statusEvent: StatusEvent = {
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
    (dappSDK.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
      connectResult,
    );
    (dappSDK.status as ReturnType<typeof vi.fn>).mockResolvedValue(
      statusEvent,
    );
    (dappSDK.listAccounts as ReturnType<typeof vi.fn>).mockResolvedValue(
      wallets,
    );

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
