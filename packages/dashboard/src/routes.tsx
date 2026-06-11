import { Routes, Route } from 'react-router';
import { AppShell } from './components/layout/AppShell.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { StreamsPage } from './pages/StreamsPage.js';
import { StreamDetailPage } from './pages/StreamDetailPage.js';
import { CreateStreamPage } from './pages/CreateStreamPage.js';
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
