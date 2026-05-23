/**
 * useHealth — TanStack Query hook for the proxy's `/api/health` endpoint.
 *
 * Shared between the TopBar (network chip) and SettingsPage (full connection
 * status). Refetches every 10s so disconnects surface quickly.
 *
 * STR-112 — Phase 2 of the UI integration.
 */
import { useQuery } from '@tanstack/react-query';
import { useConnectionStore } from '../store/connection.js';

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
  return useQuery<HealthResponse>({
    queryKey: ['health', proxyUrl],
    queryFn: async () => {
      const res = await fetch(`${proxyUrl}/api/health`);
      if (!res.ok) throw new Error(`Proxy health endpoint returned HTTP ${res.status}`);
      return (await res.json()) as HealthResponse;
    },
    refetchInterval: 10_000,
    staleTime: 8_000,
    retry: 1,
  });
}
