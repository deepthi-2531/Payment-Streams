import { Routes, Route } from 'react-router';
import { AppShell } from './components/layout/AppShell.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { StreamsPage } from './pages/StreamsPage.js';
import { StreamDetailPage } from './pages/StreamDetailPage.js';
import { CreateStreamPage } from './pages/CreateStreamPage.js';
import { CreateStreamV1Page } from './pages/CreateStreamV1Page.js';
import { V1StreamsPage } from './pages/V1StreamsPage.js';
import { V1StreamDetailPage } from './pages/V1StreamDetailPage.js';
import { EscrowsPage } from './pages/EscrowsPage.js';
import { EscrowDetailPage } from './pages/EscrowDetailPage.js';
import { CreateEscrowPage } from './pages/CreateEscrowPage.js';
import { FlowsPage } from './pages/FlowsPage.js';
import { BatchPage } from './pages/BatchPage.js';
import { InboxPage } from './pages/InboxPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { PoliciesPage } from './pages/PoliciesPage.js';
import { ExecutionLogsPage } from './pages/ExecutionLogsPage.js';
import { ExecutorStatusPage } from './pages/ExecutorStatusPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/streams" element={<StreamsPage />} />
        <Route path="/streams/:sender/:streamId" element={<StreamDetailPage />} />
        <Route path="/create" element={<CreateStreamPage />} />
        <Route path="/v1/streams" element={<V1StreamsPage />} />
        <Route path="/v1/streams/:id" element={<V1StreamDetailPage />} />
        <Route path="/v1/create" element={<CreateStreamV1Page />} />
        <Route path="/v1/escrows" element={<EscrowsPage />} />
        <Route path="/v1/escrows/create" element={<CreateEscrowPage />} />
        <Route path="/v1/escrows/:id" element={<EscrowDetailPage />} />
        <Route path="/flows" element={<FlowsPage />} />
        <Route path="/batch" element={<BatchPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/policies" element={<PoliciesPage />} />
        <Route path="/execution-logs" element={<ExecutionLogsPage />} />
        <Route path="/executor" element={<ExecutorStatusPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
