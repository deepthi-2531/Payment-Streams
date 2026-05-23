/// <reference types="vitest" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // @canton-network/dapp-sdk declares @walletconnect/sign-client +
      // @walletconnect/types as OPTIONAL peerDependencies, but Vite's
      // dep-optimizer fails to resolve them anyway. Stub them so the
      // dev-credential smoke path works without WalletConnect.
      // See packages/dashboard/src/stubs/walletconnect-sign-client-stub.js
      '@walletconnect/sign-client': path.resolve(
        here,
        'src/stubs/walletconnect-sign-client-stub.js',
      ),
      '@walletconnect/types': path.resolve(
        here,
        'src/stubs/walletconnect-sign-client-stub.js',
      ),
    },
  },
  server: {
    port: 3000,
    // Proxy /api requests to the Canton Streams REST proxy in development.
    // The proxy server wraps the Node gRPC SDK (which cannot run in the browser).
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/main.tsx', 'src/**/*.d.ts'],
    },
  },
});
