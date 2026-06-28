/**
 * Create stream page.
 *
 * Renders the 4-step `CreateStreamWizard` ported from mock `wizard.jsx`,
 * driven by the same `createStreamSchema` + `useCreateStream` mutation
 * the original single-page form used. No mock data.
 */

import { PageHeader } from '../components/common/index.js';
import { CreateStreamWizard } from '../components/streams/CreateStreamWizard.js';
import { LaneSwitch } from '../components/streams/LaneSwitch.js';

export function CreateStreamPage() {
  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Create a stream"
        subtitle="Configure the schedule and custody. The stream goes live on submit; recipient funding approval happens in the Amulet wallet."
        actions={<LaneSwitch lane="v2" kind="create" />}
      />
      <CreateStreamWizard />
    </div>
  );
}
