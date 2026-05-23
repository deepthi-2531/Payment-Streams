/**
 * CreateStreamPage — STR-117 Phase 6.
 *
 * Renders the 4-step `CreateStreamWizard` ported from mock `wizard.jsx`,
 * driven by the same `createStreamSchema` + `useCreateStream` mutation
 * the original single-page form used. No mock data.
 */

import { PageHeader } from '../components/common/index.js';
import { CreateStreamWizard } from '../components/streams/CreateStreamWizard.js';

export function CreateStreamPage() {
  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Create a stream"
        subtitle="Configure the schedule and custody. The recipient signs to activate."
      />
      <CreateStreamWizard />
    </div>
  );
}
