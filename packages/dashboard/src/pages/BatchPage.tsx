/**
 * Batch stream creation page.
 *
 * Renders the BatchUpload flow (papaparse → zod validate → fan-out
 * useCreateStream mutations). Real submit; no mock data.
 */

import { PageHeader } from '../components/common/index.js';
import { BatchUpload } from '../components/streams/BatchUpload.js';

export function BatchPage() {
  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Batch create"
        subtitle="Upload a CSV to create many streams in one signing session — payroll, vesting cohorts, mass airdrops."
      />
      <BatchUpload />
    </div>
  );
}
