/**
 * Hook to create/access a CantonStreamsApi instance.
 *
 * Uses the REST proxy instead of the Node gRPC SDK directly.
 * The gRPC SDK requires Node.js (@grpc/grpc-js, node:path, node:url)
 * and cannot run in the browser. This hook creates a fetch-based
 * API client that talks to the proxy server.
 *
 * Connection settings come from Zustand/localStorage; auth tokens
 * come from React memory only (not persisted).
 */

import { useMemo } from 'react';
import { CantonStreamsApi } from '../api/client.js';
import { useConnectionStore } from '../store/connection.js';
import { useAuth } from '../store/auth.js';

/**
 * Returns a fetch-based API client for the Canton Streams proxy.
 *
 * In development, Vite's proxy config forwards /api requests to
 * the proxy server. In production, the proxy is colocated or
 * reverse-proxied at the same origin.
 */
export function useCantonClient(): CantonStreamsApi | null {
  const { proxyUrl } = useConnectionStore();
  const { token, party } = useAuth();

  return useMemo(() => {
    if (!party) return null;

    // Use the configured proxy URL, or default to same-origin /api
    const baseUrl = proxyUrl || '';

    return new CantonStreamsApi(
      baseUrl,
      () => token,
      () => party,
    );
  }, [proxyUrl, token, party]);
}
