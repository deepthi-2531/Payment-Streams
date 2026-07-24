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
  WALLET_LAYER,
  type StreamsWalletAccount,
  type StreamsWalletNetwork,
  type StreamsWalletProviderInfo,
  type StreamsWalletStatus,
  type WalletLayer,
} from './wallet/index.js';
import { RESTORE_TIMEOUT_MS } from './wallet/config.js';
import { hasRestorableSession } from './wallet/swkSession.js';
import { hasVaultedLoopSession } from './wallet/loopSessionVault.js';

type WalletProvider = StreamsWalletProviderInfo | null;

/**
 * A non-secret hint of the last wallet session, persisted to localStorage so a
 * refresh can keep the user signed in while the wallet SDK reconnects. Holds only
 * the party id, wallet layer, and wallet id — never a token or credential.
 */
const SESSION_KEY = 'cs.session';

interface PersistedSession {
  party: string;
  layer: WalletLayer;
  walletId?: string;
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<PersistedSession>;
    return s.party && s.layer ? { party: s.party, layer: s.layer, walletId: s.walletId } : null;
  } catch {
    return null;
  }
}

function saveSession(s: PersistedSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* web storage unavailable — session hint is best-effort */
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** A persisted session is reconnectable when its layer belongs to the active
 * wallet client. The combined client owns both layers (partylayer + dapp-sdk),
 * so its `.layer` getter reads 'dapp-sdk' before connect — match on the config
 * instead so a remembered Loop session still surfaces the reconnect card. */
function sessionMatchesActiveLayer(s: PersistedSession): boolean {
  return WALLET_LAYER === 'combined' || s.layer === walletClient.layer;
}

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
  /** True while an on-load silent restore is in flight and a session might yet
   * be adopted. The app shows a neutral splash instead of the connect screen so
   * a returning user doesn't flash the reconnect card before restore settles. */
  readonly isRestoring: boolean;
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

  /** True when a returning user has a persisted session hint for the active
   * wallet layer but no live connection — drives the "Welcome back" reconnect
   * card. UI only: it never counts as an authenticated/connected session. */
  readonly canReconnect: boolean;
  /** Remembered party id from the last session (non-secret hint), or null. */
  readonly rememberedParty: string | null;
  /** Remembered wallet id to pass back to `connect()` on reconnect. */
  readonly rememberedWalletId: string | undefined;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamsWalletStatus | null>(null);
  const [accounts, setAccounts] = useState<readonly StreamsWalletAccount[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hold a neutral splash on first paint only while a session we can actually
  // restore silently is being re-adopted. A Loop-only hint is not restorable
  // today, so those users still see the reconnect card immediately (no flash).
  const [isRestoring, setIsRestoring] = useState<boolean>(() => {
    try {
      return hasRestorableSession() || hasVaultedLoopSession();
    } catch {
      return false;
    }
  });

  // Dev-mode fallback — populated only when no wallet is connected. This token is
  // the proxy bearer credential in dev-auth mode, so it lives in sessionStorage
  // (per-tab, cleared on close), not localStorage. A real wallet connection
  // always takes precedence.
  const [devToken, setDevToken] = useState<string | null>(() => {
    try { return sessionStorage.getItem('cs.devToken'); } catch { return null; }
  });
  const [devParty, setDevParty] = useState<string | null>(() => {
    try { return sessionStorage.getItem('cs.devParty'); } catch { return null; }
  });

  // Rehydrated party from the last session, used only as a bridge while the
  // wallet SDK reconnects on refresh (the account list can lag the connection).
  // Trusted only when it matches the active layer and the wallet reports
  // connected, so a stale hint can never fake an authenticated session.
  const [rememberedParty, setRememberedParty] = useState<string | null>(() => {
    const s = loadSession();
    return s && sessionMatchesActiveLayer(s) ? s.party : null;
  });
  const [connectedWalletId, setConnectedWalletId] = useState<string | undefined>(() => {
    const s = loadSession();
    return s && sessionMatchesActiveLayer(s) ? s.walletId : undefined;
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
        // Silently adopt a persisted session (SWK today; Loop once its blob
        // lands). restore() is fail-closed: a stale / wrong-party / wrong-network
        // session is skipped, leaving the reconnect card. Bounded so a slow
        // gateway can't hold the splash indefinitely.
        if (walletClient.restore) {
          const hint = loadSession();
          try {
            await Promise.race([
              walletClient.restore(
                hint ? { layer: hint.layer, party: hint.party } : undefined,
              ),
              new Promise((r) => setTimeout(r, RESTORE_TIMEOUT_MS)),
            ]);
          } catch {
            /* fall through to status() + reconnect card */
          }
          if (cancelled) return;
        }
        const current = await walletClient.status();
        if (cancelled) return;
        setStatus(current);
        setIsRestoring(false);
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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize wallet client');
          setIsRestoring(false);
        }
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
    const finish = async (): Promise<boolean> => {
      const current = await walletClient.status();
      if (!current.connection.isConnected) return false;
      setStatus(current);
      try {
        setAccounts((await walletClient.listAccounts()) ?? []);
      } catch {
        /* ignore */
      }
      // Remember the wallet actually connected (its provider id — a refresh can
      // rehydrate it), not the id we asked for, which may be a stale hint.
      setConnectedWalletId(current.provider?.id ?? walletId);
      setDevToken(null);
      setDevParty(null);
      return true;
    };
    try {
      let result = await walletClient.connect(walletId).catch((e) => {
        if (!walletId) throw e;
        return { isConnected: false } as Awaited<ReturnType<typeof walletClient.connect>>;
      });
      // A remembered wallet id can be stale/unroutable (e.g. after a redeploy, or
      // the picker chose it internally); fall back to the normal picker instead of
      // dead-ending on it.
      if (!result.isConnected && walletId) {
        result = await walletClient.connect();
      }
      if (!result.isConnected) {
        setError(result.reason ?? 'Wallet connection rejected');
        return;
      }
      await finish();
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
    setRememberedParty(null);
    setConnectedWalletId(undefined);
    clearSession();
  }, []);

  const setDevCredentials = useCallback((token: string, party: string) => {
    setDevToken(token);
    setDevParty(party);
    try {
      sessionStorage.setItem('cs.devToken', token);
      sessionStorage.setItem('cs.devParty', party);
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
  const hostedConnected = walletConnected && walletClient.capabilities.hostedMultiWallet;

  // On refresh the connection can restore a beat before the account list; bridge
  // the party from the persisted session so the user stays signed in instead of
  // bouncing to the connect screen. Only while connected, and a freshly loaded
  // account takes over as soon as it lands.
  const connectedParty = walletParty ?? (walletConnected ? rememberedParty : null);

  // Persist the (non-secret) session hint while a real wallet party is live; never
  // while disconnected (disconnect clears it explicitly). The combined picker
  // chooses the wallet id internally, so fall back to the account's
  // signingProviderId, which carries the connected PartyLayer wallet id.
  useEffect(() => {
    if (walletConnected && walletParty) {
      setRememberedParty(walletParty);
      // The connected wallet's own provider id is what connect() can route back to
      // — not the signing-provider/participant id, which is not a wallet id.
      const walletId = connectedWalletId ?? status?.provider?.id ?? undefined;
      if (walletId && walletId !== connectedWalletId) setConnectedWalletId(walletId);
      saveSession({ party: walletParty, layer: walletClient.layer, walletId });
    }
  }, [walletConnected, walletParty, connectedWalletId, status]);

  // Hosted wallets (Loop) can drop their in-memory session silently — a failed
  // submit or expired handshake doesn't always fire a disconnect event. Re-read
  // status on refocus and a slow interval so a dropped session flips back to the
  // connect screen without a manual refresh.
  useEffect(() => {
    if (!hostedConnected) return;
    let cancelled = false;
    const recheck = () => {
      void walletClient
        .status()
        .then((latest) => {
          if (cancelled) return;
          setStatus(latest);
          if (!latest.connection.isConnected) setAccounts([]);
        })
        .catch(() => {
          /* transient read failure — don't sign the user out on a blip */
        });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', recheck);
    const timer = window.setInterval(recheck, 30_000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', recheck);
      window.clearInterval(timer);
    };
  }, [hostedConnected]);

  // Wallet session takes precedence; dev-mode fills the gap only when
  // no real wallet is connected.
  const token = walletConnected ? walletToken : devToken;
  const party = walletConnected ? connectedParty : devParty;
  const devMode = !walletConnected && Boolean(devToken && devParty);

  // Hosted wallets may route ledger access through their own provider rather
  // than exposing a bearer token to the dApp. Treat a connected hosted wallet
  // with a party id as an authenticated dashboard session.
  const hostedWalletAuth =
    walletConnected &&
    walletClient.capabilities.hostedMultiWallet &&
    !walletToken &&
    Boolean(connectedParty);

  const isAuthenticated = hostedWalletAuth || Boolean(token && party);

  // A returning user with a matching session hint but no live connection and no
  // dev session. Drives the "Welcome back" card — UI only; never fabricates a session.
  const canReconnect =
    !isAuthenticated &&
    !isConnecting &&
    !walletConnected &&
    !devMode &&
    rememberedParty !== null;

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
      isRestoring,
      error,
      connect,
      disconnect,
      clearCredentials: () => {
        void disconnect();
      },
      devMode,
      setDevCredentials,
      canCreateCustodyStream,
      canReconnect,
      rememberedParty,
      rememberedWalletId: connectedWalletId,
    }),
    [
      token,
      party,
      accounts,
      primaryAccount,
      status,
      isAuthenticated,
      isConnecting,
      isRestoring,
      error,
      connect,
      disconnect,
      devMode,
      setDevCredentials,
      canCreateCustodyStream,
      canReconnect,
      rememberedParty,
      connectedWalletId,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
