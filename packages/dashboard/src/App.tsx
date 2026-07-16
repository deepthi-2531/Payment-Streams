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

/** Render the dashboard only after a wallet or dev session is available. */
function AuthGate() {
  const { isAuthenticated } = useAuth();
  useAccountsChangedInvalidation();
  if (!isAuthenticated) return <ConnectFlow />;
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
