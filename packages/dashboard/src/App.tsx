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

/** Neutral first-paint panel shown while a persisted session is being restored,
 * so a returning user doesn't flash the connect / reconnect screen. */
function RestoreSplash() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--color-text-muted, #888)',
        fontSize: 14,
      }}
    >
      Restoring your session…
    </div>
  );
}

/** Render the dashboard only after a wallet or dev session is available. */
function AuthGate() {
  const { isAuthenticated, isRestoring } = useAuth();
  useAccountsChangedInvalidation();
  if (!isAuthenticated) return isRestoring ? <RestoreSplash /> : <ConnectFlow />;
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
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
