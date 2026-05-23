import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { AuthProvider, useAuth } from './store/auth.js';
import { AppRoutes } from './routes.js';
import { ErrorBoundary } from './components/common/ErrorBoundary.js';
import { ConnectFlow } from './components/wallet/index.js';
import { useAccountsChangedInvalidation } from './hooks/useAccountsChangedInvalidation.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
    },
  },
});

/**
 * Auth gate — Phase 7 / STR-118.
 *
 * Until the user connects a wallet (or supplies dev-mode credentials),
 * we render the split-screen ConnectFlow instead of the dashboard
 * shell. This keeps the protected routes from ever calling the proxy
 * without a real session token.
 */
function AuthGate() {
  const { isAuthenticated } = useAuth();
  // STR-123: any time the wallet's primary party changes (or
  // disconnects), invalidate every cached query so the dashboard
  // refetches against the new identity. Lives at the gate so it
  // mounts once, above all routes.
  useAccountsChangedInvalidation();
  if (!isAuthenticated) return <ConnectFlow />;
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <AuthGate />
        </QueryClientProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
