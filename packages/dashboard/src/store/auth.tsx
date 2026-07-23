/**
 * Auth context — backed by the dashboard wallet-client abstraction.
 *
 * The app prefers a connected wallet session. A local dev fallback remains
 * available through Settings for environments without a wallet.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

  /** True when the acting party is hosted on a participant that vets the
   * canton-streams DAR (dev/proxy-hosted parties such as streamsbob, and
   * dapp-SDK/SWK parties on the operator's validator). False for a live
   * custodial multi-wallet (Loop) whose participant can't run our DAR — the
   * custody create lane would fail there, so the UI routes it to direct
   * delivery instead. */
  readonly canCreateCustodyStream: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamsWalletStatus | null>(null);
  const [accounts, setAccounts] = useState<readonly StreamsWalletAccount[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dev-mode fallback — populated only when no wallet is connected. Persisted to
  // localStorage so a page refresh doesn't silently log the dev session out (the
  // dev JWT only names a public party id; it is not a credential to anything
  // sensitive). A real wallet connection always takes precedence over this.
  const [devToken, setDevToken] = useState<string | null>(() => {
    try { return localStorage.getItem('cs.devToken'); } catch { return null; }
  });
  const [devParty, setDevParty] = useState<string | null>(() => {
    try { return localStorage.getItem('cs.devParty'); } catch { return null; }
  });

  // Let StrictMode remount this effect naturally. The cleanup detaches the
  // wallet listeners from the previous run.
  useEffect(() => {
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
        // Subscribe before the first snapshot so async wallet restores can
        // update the app as soon as the provider reports a session.
        await walletClient.onStatusChanged(handleStatus);
        await walletClient.onAccountsChanged(handleAccounts);
        await walletClient.onConnected(handleConnected);
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
        } else if (walletClient.capabilities.hostedMultiWallet) {
          // Some hosted wallets finish restoring shortly after initial load.
          // A single delayed check keeps refreshes from stranding users on
          // the connect screen. (We do NOT auto-call connect() here — that can
          // open the Loop window uninvited or strand a returning user mid-flow.
          // The Loop SDK restores its own session; the user re-connects if not.)
          setTimeout(() => {
            if (cancelled) return;
            void walletClient
              .status()
              .then((latest) => {
                if (cancelled) return;
                if (latest.connection.isConnected) setStatus(latest);
                return walletClient.listAccounts();
              })
              .then((list) => {
                if (!cancelled && list) setAccounts(list);
              })
              .catch(() => {
                /* ignore — primary path is the subscriber */
              });
          }, 4_000);
        }
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
  }, []);

  const setDevCredentials = useCallback((token: string, party: string) => {
    setDevToken(token);
    setDevParty(party);
    try {
      localStorage.setItem('cs.devToken', token);
      localStorage.setItem('cs.devParty', party);
    } catch {
      /* web storage unavailable — fall back to in-memory only */
    }
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

  // Hosted wallets may route ledger access through their own provider rather
  // than exposing a bearer token to the dApp. Treat a connected hosted wallet
  // with a party id as an authenticated dashboard session.
  const hostedWalletAuth =
    walletConnected &&
    walletClient.capabilities.hostedMultiWallet &&
    !walletToken &&
    Boolean(walletParty);

  const isAuthenticated = hostedWalletAuth || Boolean(token && party);

  // A live custodial multi-wallet (Loop) routes ledger access through its own
  // participant, which does NOT vet our canton-streams DAR — so it cannot create
  // the V2 custody stream (a signatory contract needs the package vetted on the
  // payer's own participant). Such wallets get Direct delivery + Vault instead.
  // Dev/proxy-hosted parties and dapp-SDK/SWK parties run on the operator's
  // validator, which does vet the DAR, so they keep the V2 custody lane.
  //
  // (We used to read-probe the DAR on the wallet's participant, but an ACS read
  // for an unvetted template returns empty rather than erroring, so the probe
  // reported a false "vetted" and offered a lane that fails at create time.)
  const isCustodialWallet =
    walletConnected &&
    walletClient.capabilities.hostedMultiWallet &&
    walletClient.capabilities.ledgerApi;

  const canCreateCustodyStream = devMode || !isCustodialWallet;

  const value: AuthContextValue = useMemo(
    () => ({
      token,
      party,
      accounts,
      signingProviderId: primaryAccount?.signingProviderId ?? null,
      network: status?.network ?? null,
      provider: status?.provider ?? null,
      isAuthenticated,
      isConnecting,
      error,
      connect,
      disconnect,
      clearCredentials: () => {
        void disconnect();
      },
      devMode,
      setDevCredentials,
      canCreateCustodyStream,
    }),
    [
      token,
      party,
      accounts,
      primaryAccount,
      status,
      isAuthenticated,
      isConnecting,
      error,
      connect,
      disconnect,
      devMode,
      setDevCredentials,
      canCreateCustodyStream,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
