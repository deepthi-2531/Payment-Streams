/**
 * Create stream page.
 *
 * Renders the 4-step `CreateStreamWizard` ported from mock `wizard.jsx`,
 * driven by the same `createStreamSchema` + `useCreateStream` mutation
 * the original single-page form used. No mock data.
 */

import { Navigate } from 'react-router';
import { PageHeader } from '../components/common/index.js';
import { CreateStreamWizard } from '../components/streams/CreateStreamWizard.js';
import { LaneSwitch } from '../components/streams/LaneSwitch.js';
import { useAuth } from '../store/auth.js';

export function CreateStreamPage() {
  const { canCreateCustodyStream } = useAuth();
  // The custody (allocation) lane submits a canton-streams contract through the
  // connected wallet's participant. A custodial wallet (Loop) can't run our
  // DAR, so that create would hang — route it to direct delivery instead.
  if (!canCreateCustodyStream) return <Navigate to="/v1/create" replace />;
  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Create a stream"
        subtitle="Advanced custody lane — funds are allocation-backed and approved through the Amulet wallet. Most streams should use Direct delivery."
        actions={<LaneSwitch lane="v2" kind="create" />}
      />
      <CreateStreamWizard />
    </div>
  );
}
