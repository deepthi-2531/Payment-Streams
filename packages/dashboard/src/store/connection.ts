/**
 * Connection settings store.
 *
 * Persists the proxy URL to localStorage via Zustand.
 * Credentials (JWT tokens) are NOT stored here — they live in React memory only.
 *
 * The dashboard talks to the REST proxy (not Canton directly). The proxy URL
 * defaults to same-origin (empty string) for Vite dev proxy or colocated
 * production deployments.
 *
 * Canton connection settings (host/port/TLS) are managed server-side by the
 * proxy via environment variables. The dashboard reads them from GET /api/health
 * for display purposes only.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ConnectionSettings {
  /** REST proxy URL. Empty string = same-origin (Vite dev proxy or colocated). */
  proxyUrl: string;
}

interface ConnectionStore extends ConnectionSettings {
  setProxyUrl: (proxyUrl: string) => void;
}

export const useConnectionStore = create<ConnectionStore>()(
  persist(
    (set) => ({
      proxyUrl: '',
      setProxyUrl: (proxyUrl) => set({ proxyUrl }),
    }),
    {
      name: 'canton-streams-connection',
    },
  ),
);
