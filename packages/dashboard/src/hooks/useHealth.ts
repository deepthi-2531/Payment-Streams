/**
 * useHealth — TanStack Query hook for the proxy's `/api/health` endpoint.
 *
 * Shared between the TopBar (network chip) and SettingsPage (full connection
 * status). Refetches every 10s so disconnects surface quickly.
 *
 * Fetches proxy health for the dashboard.
 */
import { useQuery } from '@tanstack/react-query';
import { useConnectionStore, safeProxyUrl } from '../store/connection.js';
import { walletClient } from '../store/wallet/index.js';
import { useAuth } from '../store/auth.js';

export interface HealthResponse {
  readonly status: string;
  readonly canton: { readonly host: string; readonly port: number };
  readonly readiness?: {
    readonly status: string;
    readonly checkedAt?: string;
    readonly checks?: Record<string, { status: string; message: string }>;
  } | null;
}

/**
 * Derives a human-friendly network label from the canton host.
 *
 * Examples:
 *   - `canton-mainnet.example.com` → `canton:mainnet`
 *   - `testnet.example.com` → `canton:testnet`
 *   - `localhost` → `canton:local`
 *   - `127.0.0.1` → `canton:local`
 *
 * Falls back to the raw host if no pattern matches.
 */
export function networkLabelFromHost(host: string | undefined): string {
  if (!host) return 'canton:unknown';
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.')) {
    return 'canton:local';
  }
  const lower = host.toLowerCase();
  for (const env of ['mainnet', 'testnet', 'devnet', 'staging', 'preview'] as const) {
    if (lower.includes(env)) return `canton:${env}`;
  }
  // Take the first segment of the FQDN as a best-effort label.
  const first = lower.split('.')[0];
  return `canton:${first ?? 'unknown'}`;
}

export function useHealth() {
  const { proxyUrl } = useConnectionStore();
  const { token, network } = useAuth();
  // Hosted-multi-wallet sessions (Loop / Cantor8 / Send) don't hand
  // us a JWT; the proxy is not in the request path either. Synthesize
  // a health report from the wallet's network metadata so the TopBar
  // chip shows the actual network rather than a confusing "proxy
  // unreachable" error.
  const isHostedWallet =
    !token &&
    walletClient.capabilities.hostedMultiWallet &&
    walletClient.capabilities.ledgerApi;
  return useQuery<HealthResponse>({
    queryKey: ['health', proxyUrl, isHostedWallet, network?.networkId],
    queryFn: async () => {
      if (isHostedWallet) {
        // CAIP-2 ids look like `canton:da-devnet`. Strip the prefix +
        // give it back as a host-shaped string so
        // `networkLabelFromHost` lights up the right environment chip.
        const caip = network?.networkId ?? '';
        const host = caip.includes(':') ? caip.split(':')[1] ?? caip : caip;
        return {
          status: 'ok',
          canton: { host: host || 'devnet', port: 443 },
          readiness: {
            status: 'ok',
            checks: {
              wallet: {
                status: 'ok',
                message: `Routing through ${walletClient.name}`,
              },
            },
          },
        };
      }
      const base = safeProxyUrl(proxyUrl);
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) throw new Error(`Proxy health endpoint returned HTTP ${res.status}`);
      return (await res.json()) as HealthResponse;
    },
    refetchInterval: 10_000,
    staleTime: 8_000,
    retry: 1,
  });
}
