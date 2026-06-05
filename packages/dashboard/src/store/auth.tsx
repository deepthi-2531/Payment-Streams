/**
 * Auth context — backed by the dashboard wallet-client abstraction.
 *
 * STR-118 / Phase 7: replaced the JWT-paste session-storage flow with
 * a real wallet connection. The dashboard no longer stores wallet
 * tokens; it asks the active wallet adapter for the current session
 * and forwards the access token to the proxy and ledger reads.
 *
 * Surface (kept compatible with the rest of the app):
 *   • `token` — current `session.accessToken` from the wallet (or null)
 *   • `party` — `partyId` of the primary wallet account (or null)
 *   • `accounts` — every wallet account the user has authorized
 *   • `signingProviderId` — id of the primary wallet's signing provider
 *   • `network` — connected canton network metadata
 *   • `provider` — the selected wallet provider descriptor
 *   • `isAuthenticated` — convenience boolean
 *   • `isConnecting` — flag while the wallet connection is in flight
 *   • `connect()`  — opens the picker, or direct-connects when configured
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
  walletClient,
  type StreamsWalletAccount,
  type StreamsWalletNetwork,
  type StreamsWalletProviderInfo,
  type StreamsWalletStatus,
} from './wallet/index.js';

type WalletProvider = StreamsWalletProviderInfo | null;

interface AuthContextValue {
  // Session
  readonly token: string | null;
  readonly party: string | null;
  readonly accounts: readonly StreamsWalletAccount[];
  readonly signingProviderId: string | null;
  readonly network: StreamsWalletNetwork | null;
  readonly provider: WalletProvider;
  readonly isAuthenticated: boolean;
  readonly isConnecting: boolean;
  readonly error: string | null;

  // Wallet-driven controls
  readonly connect: (walletId?: string) => Promise<void>;
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
  const [status, setStatus] = useState<StreamsWalletStatus | null>(null);
  const [accounts, setAccounts] = useState<readonly StreamsWalletAccount[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dev-mode fallback — populated only when no wallet is connected.
  const devInitial = readDevSession();
  const [devToken, setDevToken] = useState<string | null>(devInitial.token);
  const [devParty, setDevParty] = useState<string | null>(devInitial.party);

  const initRef = useRef(false);

  // Cold-start: init wallet client once, restore persisted session, subscribe to
  // status / accounts / connected events.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const handleStatus = (event: StreamsWalletStatus) => setStatus(event);
    const handleAccounts = (event: readonly StreamsWalletAccount[]) =>
      setAccounts(event ?? []);
    const handleConnected = (event: StreamsWalletStatus) => {
      setStatus(event);
      setError(null);
      // best-effort refresh of accounts post-connect
      void walletClient
        .listAccounts()
        .then((list) => setAccounts(list ?? []))
        .catch(() => {
          /* swallow — surface via status.connection.reason */
        });
    };

    let cancelled = false;
    (async () => {
      try {
        await walletClient.init();
        if (cancelled) return;
        const current = await walletClient.status();
        if (cancelled) return;
        setStatus(current);
        if (current.connection.isConnected) {
          try {
            const list = await walletClient.listAccounts();
            if (!cancelled) setAccounts(list ?? []);
          } catch {
            /* ignore */
          }
        }
        await walletClient.onStatusChanged(handleStatus);
        await walletClient.onAccountsChanged(handleAccounts);
        await walletClient.onConnected(handleConnected);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to initialize wallet client');
      }
    })();

    return () => {
      cancelled = true;
      // best-effort detach; listeners are tied to the wallet-client singleton
      void walletClient.removeOnStatusChanged(handleStatus).catch(() => {});
      void walletClient.removeOnAccountsChanged(handleAccounts).catch(() => {});
      void walletClient.removeOnConnected(handleConnected).catch(() => {});
    };
  }, []);

  const connect = useCallback(async (walletId?: string) => {
    setIsConnecting(true);
    setError(null);
    try {
      const result = await walletClient.connect(walletId);
      if (!result.isConnected) {
        setError(result.reason ?? 'Wallet connection rejected');
        return;
      }
      const current = await walletClient.status();
      setStatus(current);
      try {
        const list = await walletClient.listAccounts();
        setAccounts(list ?? []);
      } catch {
        /* ignore */
      }
      // Real wallet wins over dev-mode credentials.
      setDevToken(null);
      setDevParty(null);
      writeDevSession(null, null);
    } catch (err) {
      setError(await walletClient.describeConnectError(err));
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await walletClient.disconnect();
    } catch {
      /* swallow — we still clear local state */
    }
    setStatus(null);
    setAccounts([]);
    setError(null);
    setDevToken(null);
    setDevParty(null);
    writeDevSession(null, null);
  }, []);

  const setDevCredentials = useCallback((token: string, party: string) => {
    setDevToken(token);
    setDevParty(party);
    writeDevSession(token, party);
  }, []);

  const primaryAccount = useMemo<StreamsWalletAccount | null>(() => {
    if (accounts.length === 0) return null;
    return accounts.find((a) => a.primary) ?? accounts[0] ?? null;
  }, [accounts]);

  const walletToken = status?.network?.accessToken ?? status?.session?.accessToken ?? null;
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
