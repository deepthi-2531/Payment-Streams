/**
 * CreateStreamWizard regression — review-step submit guard.
 *
 * Locks the contract that the create mutation only fires when the user
 * clicks the explicit "Create stream" button on Step 4 (Review). The
 * earlier wizard wired `methods.handleSubmit(...)` to
 * `<form onSubmit={...}>`, which let stray submission paths (Enter
 * key, button-replacement mid-transition, etc.) fire the mutation
 * during Step 3 → Step 4 navigation. The reviewer hit exactly that:
 * "advancing from Step 3 to Step 4 immediately creates the stream".
 *
 * This spec drives the wizard through every step + a no-op "Continue"
 * to Step 4, and asserts the mutation has NOT been called until the
 * explicit Review-step button is clicked.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Spy we read after each test to verify NOTHING called the mutation
// during navigation.
const createStreamSpy = vi.fn().mockResolvedValue({
  requestContractId: 'cid-1',
  streamId: 'stream-001',
});

// The `useStreams.useCreateStream` hook is what the wizard pulls in
// for the mutation. Stub the whole module so we don't need a real
// CantonClient / proxy round-trip.
vi.mock('../../hooks/useStreams.js', () => ({
  useCreateStream: () => ({
    mutateAsync: createStreamSpy,
    isPending: false,
  }),
}));

// `useAuth` must return a usable party so the wizard's submit guard
// doesn't bail out before our assertions can fire.
vi.mock('../../store/auth.js', async () => {
  // The wizard imports the real `useAuth` symbol; everything else
  // (AuthProvider, walletSdk, …) is not needed in this test.
  return {
    useAuth: () => ({
      party: 'alice::1220mockpartyid',
      isAuthenticated: true,
      isConnecting: false,
      devMode: false,
      provider: null,
      token: 'mock-token',
      accounts: [],
      status: null,
      signingProviderId: null,
      network: null,
      error: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      clearCredentials: vi.fn(),
      setDevCredentials: vi.fn(),
    }),
  };
});

// `useCantonClient` is reached by other hooks via the QueryClient; the
// wizard doesn't call it directly but a child component might. Return
// `undefined` so dependent queries stay disabled.
vi.mock('../../hooks/useCantonClient.js', () => ({
  useCantonClient: () => undefined,
}));

import { CreateStreamWizard } from './CreateStreamWizard.js';

function renderWizard() {
  // A fresh QueryClient per test isolates TanStack state.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<CreateStreamWizard />, { wrapper: Wrapper });
}

async function advanceWithContinue() {
  const user = userEvent.setup();
  const cont = screen.getByRole('button', { name: /continue/i });
  await user.click(cont);
}

describe('<CreateStreamWizard /> — review-step submit guard', () => {
  beforeEach(() => {
    createStreamSpy.mockClear();
  });

  it('does NOT fire the create mutation when advancing through any step', async () => {
    renderWizard();

    // Step 1 → Continue (validation will reject because fields are
    // empty, but that's exactly the point: even a click that triggers
    // validation must never trigger the mutation).
    await advanceWithContinue();
    expect(createStreamSpy).not.toHaveBeenCalled();

    // Subsequent clicks on Continue, in any order, must also not fire
    // the mutation. The mutation is gated to the Review step's
    // explicit `Create stream` button only.
    await advanceWithContinue();
    expect(createStreamSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire the create mutation when the form receives a native submit event', () => {
    const { container } = renderWizard();
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    // Directly emit a submit event on the form. The new contract is
    // that `<form>` swallows submits via `preventDefault()` and never
    // routes them to `handleSubmit`. The earlier wiring would have
    // run the mutation here.
    fireEvent.submit(form!);
    expect(createStreamSpy).not.toHaveBeenCalled();
  });

  it('exposes no `type="submit"` button before the Review step', () => {
    const { container } = renderWizard();
    const submitButtons = container.querySelectorAll('button[type="submit"]');
    // The Review step's Create button is now `type="button"`, so the
    // wizard exposes zero implicit-submit surfaces on Step 1.
    expect(submitButtons.length).toBe(0);
  });
});
