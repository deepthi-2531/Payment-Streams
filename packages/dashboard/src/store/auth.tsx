/**
 * Auth context — backed by @canton-network/dapp-sdk.
 *
 * STR-118 / Phase 7: replaced the JWT-paste session-storage flow with
 * a real Splice Wallet Kernel connection. The dashboard no longer
 * stores tokens; it asks the dapp-sdk for the current session and
 * forwards the access token to the proxy and ledger reads.
 *
 * Surface (kept compatible with the rest of the app):
 *   • `token` — current `session.accessToken` from the wallet (or null)
 *   • `party` — `partyId` of the primary wallet account (or null)
 *   • `accounts` — every wallet account the user has authorized
 *   • `signingProviderId` — id of the primary wallet's signing provider
 *   • `network` — connected canton network metadata
 *   • `provider` — the selected wallet provider descriptor
 *   • `isAuthenticated` — convenience boolean
 *   • `isConnecting` — flag while the picker is open
 *   • `connect()`  — opens the wallet picker (sdk.connect)
 *   • `disconnect()` — clears the session (sdk.disconnect)
 *   • `clearCredentials()` — alias of disconnect, kept for older callers
 *
 * The proxy fallback ("dev-mode") path is preserved via
 * `setDevCredentials` so local development without a wallet still works,
 * but it's intentionally separate from `connect()` and exposed only via
 * the Settings page.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  dappSDK,
  RemoteAdapter,
  type StatusEvent,
  type Wallet,
  type Network,
  type ListAccountsResult,
} from '@canton-network/dapp-sdk';

/**
 * Dev-only: skip the dapp-sdk wallet picker UI and auto-select a local
 * Splice Wallet Kernel.
 *
 * The picker is a popup window — in many headless / automation flows
 * the popup ends up in a browser window outside the automation tab
 * tracker and can't be clicked through. It's also unnecessary noise
 * when only one wallet is available locally. When
 * `VITE_SKIP_WALLET_PICKER=true`, we pass a no-UI `walletPicker` to
 * `dappSDK.init()` that returns the first `remote` entry it finds,
 * falling back to a synthetic remote entry pointing at
 * `VITE_WALLET_GATEWAY_URL` (default `http://localhost:3030/api/v0/dapp`).
 *
 * Production builds and any user who doesn't set the flag still get the
 * normal picker UX.
 */
const SKIP_PICKER =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.['VITE_SKIP_WALLET_PICKER'] === 'true';
const WALLET_GATEWAY_URL =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.['VITE_WALLET_GATEWAY_URL'] ??
  'http://localhost:3030/api/v0/dapp';

type PickerEntry = {
  readonly providerId: string;
  readonly name: string;
  readonly type: string;
  readonly url?: string;
};

async function autoRemotePicker(
  entries: readonly PickerEntry[],
): Promise<PickerEntry> {
  const remote = entries.find((e) => e.type === 'remote' && e.url);
  if (remote) return remote;
  // Fall back to constructing a synthetic remote entry pointing at the
  // configured wallet-gateway URL. The SDK will register a fresh
  // RemoteAdapter for it on the connection attempt.
  return {
    providerId: `remote:${WALLET_GATEWAY_URL}`,
    name: 'Splice Wallet Kernel',
    type: 'remote',
    url: WALLET_GATEWAY_URL,
  };
}

const SKIP_PICKER_INIT_OPTIONS = SKIP_PICKER
  ? {
      additionalAdapters: [
        new RemoteAdapter({
          name: 'Splice Wallet Kernel',
          rpcUrl: WALLET_GATEWAY_URL,
        }),
      ],
      walletPicker: autoRemotePicker as unknown as never,
    }
  : undefined;

type WalletProvider = StatusEvent['provider'] | null;

interface AuthContextValue {
  // Session
  readonly token: string | null;
  readonly party: string | null;
  readonly accounts: readonly Wallet[];
  readonly signingProviderId: string | null;
  readonly network: Network | null;
  readonly provider: WalletProvider;
  readonly isAuthenticated: boolean;
  readonly isConnecting: boolean;
  readonly error: string | null;

  // Wallet-driven controls
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  /** Alias of disconnect — kept so older callers compile. */
  readonly clearCredentials: () => void;

  // Dev-mode fallback (no real wallet)
  readonly devMode: boolean;
  readonly setDevCredentials: (token: string, party: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEV_TOKEN_KEY = 'canton-streams-dev-token';
const DEV_PARTY_KEY = 'canton-streams-dev-party';

function readDevSession(): { token: string | null; party: string | null } {
  try {
    return {
      token: sessionStorage.getItem(DEV_TOKEN_KEY),
      party: sessionStorage.getItem(DEV_PARTY_KEY),
    };
  } catch {
    return { token: null, party: null };
  }
}

function writeDevSession(token: string | null, party: string | null) {
  try {
    if (token && party) {
      sessionStorage.setItem(DEV_TOKEN_KEY, token);
      sessionStorage.setItem(DEV_PARTY_KEY, party);
    } else {
      sessionStorage.removeItem(DEV_TOKEN_KEY);
      sessionStorage.removeItem(DEV_PARTY_KEY);
    }
  } catch {
    // sessionStorage may be unavailable (incognito etc.)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusEvent | null>(null);
  const [accounts, setAccounts] = useState<readonly Wallet[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dev-mode fallback — populated only when no wallet is connected.
  const devInitial = readDevSession();
  const [devToken, setDevToken] = useState<string | null>(devInitial.token);
  const [devParty, setDevParty] = useState<string | null>(devInitial.party);

  const initRef = useRef(false);

  // Cold-start: init dapp-sdk once, restore persisted session, subscribe to
  // status / accounts / connected events.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const handleStatus = (event: StatusEvent) => setStatus(event);
    const handleAccounts = (event: readonly Wallet[]) =>
      setAccounts(event ?? []);
    const handleConnected = (event: StatusEvent) => {
      setStatus(event);
      setError(null);
      // best-effort refresh of accounts post-connect
      void dappSDK
        .listAccounts()
        .then((list: ListAccountsResult) => setAccounts(list ?? []))
        .catch(() => {
          /* swallow — surface via status.connection.reason */
        });
    };

    let cancelled = false;
    (async () => {
      try {
        await (SKIP_PICKER_INIT_OPTIONS
          ? dappSDK.init(SKIP_PICKER_INIT_OPTIONS)
          : dappSDK.init());
        if (cancelled) return;
        const current = await dappSDK.status();
        if (cancelled) return;
        setStatus(current);
        if (current.connection.isConnected) {
          try {
            const list = await dappSDK.listAccounts();
            if (!cancelled) setAccounts(list ?? []);
          } catch {
            /* ignore */
          }
        }
        await dappSDK.onStatusChanged(handleStatus);
        await dappSDK.onAccountsChanged(handleAccounts);
        await dappSDK.onConnected(handleConnected);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error
              ? err.message
              : 'Failed to initialize wallet SDK',
          );
      }
    })();

    return () => {
      cancelled = true;
      // best-effort detach; listeners are tied to the SDK singleton
      void dappSDK.removeOnStatusChanged(handleStatus).catch(() => {});
      void dappSDK.removeOnAccountsChanged(handleAccounts).catch(() => {});
      void dappSDK.removeOnConnected(handleConnected).catch(() => {});
    };
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const result = await dappSDK.connect();
      if (!result.isConnected) {
        setError(result.reason ?? 'Wallet connection rejected');
        return;
      }
      const current = await dappSDK.status();
      setStatus(current);
      try {
        const list = await dappSDK.listAccounts();
        setAccounts(list ?? []);
      } catch {
        /* ignore */
      }
      // Real wallet wins over dev-mode credentials.
      setDevToken(null);
      setDevParty(null);
      writeDevSession(null, null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Wallet connection failed',
      );
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await dappSDK.disconnect();
    } catch {
      /* swallow — we still clear local state */
    }
    setStatus(null);
    setAccounts([]);
    setDevToken(null);
    setDevParty(null);
    writeDevSession(null, null);
  }, []);

  const setDevCredentials = useCallback(
    (token: string, party: string) => {
      setDevToken(token);
      setDevParty(party);
      writeDevSession(token, party);
    },
    [],
  );

  const primaryAccount = useMemo<Wallet | null>(() => {
    if (accounts.length === 0) return null;
    return accounts.find((a) => a.primary) ?? accounts[0] ?? null;
  }, [accounts]);

  const walletToken =
    status?.network?.accessToken ?? status?.session?.accessToken ?? null;
  const walletParty = primaryAccount?.partyId ?? null;
  const walletConnected = Boolean(status?.connection.isConnected);

  // Wallet session takes precedence; dev-mode fills the gap only when
  // no real wallet is connected.
  const token = walletConnected ? walletToken : devToken;
  const party = walletConnected ? walletParty : devParty;
  const devMode = !walletConnected && Boolean(devToken && devParty);

  const value: AuthContextValue = useMemo(
    () => ({
      token,
      party,
      accounts,
      signingProviderId: primaryAccount?.signingProviderId ?? null,
      network: status?.network ?? null,
      provider: status?.provider ?? null,
      isAuthenticated: Boolean(token && party),
      isConnecting,
      error,
      connect,
      disconnect,
      clearCredentials: () => {
        void disconnect();
      },
      devMode,
      setDevCredentials,
    }),
    [
      token,
      party,
      accounts,
      primaryAccount,
      status,
      isConnecting,
      error,
      connect,
      disconnect,
      devMode,
      setDevCredentials,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
