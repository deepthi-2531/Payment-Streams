/**
 * Test-only fixtures — Phase 8 / STR-119.
 *
 * IMPORTANT: this file is the **only** allowed home for mock proxy
 * payloads. It lives under `src/test/` so the production
 * mock-fixtures grep gate (Phase 5 acceptance) excludes it.
 *
 * Shapes mirror the `RawStream`/`RawPolicy`/`RawExecutionLog` interfaces
 * in `src/api/client.ts`. Date+Decimal fields are kept as strings — the
 * deserializer in api/client.ts converts them.
 */

import { AssetType, SettlementMode, VestingMode } from '@canton-streams/sdk/browser';

const aliceParty = 'alice::1220abcdef';
const bobParty = 'bob::1220beefcafe';
const escrowParty = 'EscrowOperator::1220de1';

interface RawStream {
  contractId: string;
  config: {
    streamId: string;
    sender: string;
    recipient: string;
    totalDeposited: string;
    startTime: string;
    endTime: string;
    vestingMode: { mode: string; cliffTime?: string };
    assetType: string;
    settlementMode?: string;
    cancellable: boolean;
    instrumentRef?: { instrumentId: string; admin: string } | null;
  };
  state: {
    totalWithdrawn: string;
    status: string;
    lastWithdrawTime?: string;
    renewalCount: number;
  };
}

interface RawPendingRequest {
  contractId: string;
  config: RawStream['config'];
}

interface RawPolicy {
  contractId: string;
  policyId: string;
  sender: string;
  recipient: string;
  executor: string;
  escrowOperator: string;
  allowedActions: string[];
  rateLimit: {
    maxExecutionsPerPeriod: number;
    periodDuration: number;
    maxAmountPerExecution: string;
    cooldownInterval: number;
  };
  streamFilters: string[];
  active: boolean;
  expiresAt: string;
  createdAt: string;
}

interface RawExecutionLog {
  contractId: string;
  policyId: string;
  executionId: string;
  sender: string;
  executor: string;
  targetStreamId: string;
  action: string;
  amount: string;
  executionTime: string;
  success: boolean;
  errorMessage?: string;
}

const rawStreams: RawStream[] = [
  {
    contractId: 'stream-cid-1',
    config: {
      streamId: 'stream-001',
      sender: aliceParty,
      recipient: bobParty,
      totalDeposited: '1000.00',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-12-31T00:00:00.000Z',
      vestingMode: { mode: VestingMode.Linear },
      assetType: AssetType.GlobalCip56,
      settlementMode: SettlementMode.UtilityHoldingCustody,
      cancellable: true,
      instrumentRef: null,
    },
    state: {
      totalWithdrawn: '250.00',
      status: 'Active',
      renewalCount: 0,
    },
  },
  {
    contractId: 'stream-cid-2',
    config: {
      streamId: 'stream-002',
      sender: aliceParty,
      recipient: bobParty,
      totalDeposited: '5000.00',
      startTime: '2026-03-01T00:00:00.000Z',
      endTime: '2027-03-01T00:00:00.000Z',
      vestingMode: { mode: VestingMode.CliffLinear, cliffTime: '2026-06-01T00:00:00.000Z' },
      assetType: AssetType.GlobalCip56,
      settlementMode: SettlementMode.UtilityHoldingCustody,
      cancellable: false,
      instrumentRef: null,
    },
    state: {
      totalWithdrawn: '0.00',
      status: 'Active',
      renewalCount: 0,
    },
  },
];

const rawPendingRequests: RawPendingRequest[] = [
  {
    contractId: 'pending-cid-1',
    config: {
      streamId: 'pending-001',
      sender: aliceParty,
      recipient: bobParty,
      totalDeposited: '500.00',
      startTime: '2026-02-01T00:00:00.000Z',
      endTime: '2026-08-01T00:00:00.000Z',
      vestingMode: { mode: VestingMode.Linear },
      assetType: AssetType.GlobalCip56,
      settlementMode: SettlementMode.UtilityHoldingCustody,
      cancellable: true,
      instrumentRef: null,
    },
  },
];

const rawPolicies: RawPolicy[] = [
  {
    contractId: 'policy-cid-1',
    policyId: 'policy-001',
    sender: aliceParty,
    recipient: bobParty,
    executor: 'executor::1220ff',
    escrowOperator: escrowParty,
    allowedActions: ['Withdraw'],
    rateLimit: {
      maxExecutionsPerPeriod: 10,
      periodDuration: 86_400_000_000,
      maxAmountPerExecution: '100.00',
      cooldownInterval: 0,
    },
    streamFilters: [],
    active: true,
    expiresAt: '2027-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

const rawExecutionLogs: RawExecutionLog[] = [
  {
    contractId: 'log-cid-1',
    policyId: 'policy-001',
    executionId: 'exec-001',
    sender: aliceParty,
    executor: 'executor::1220ff',
    targetStreamId: 'stream-001',
    action: 'Withdraw',
    amount: '50.00',
    executionTime: '2026-02-01T12:00:00.000Z',
    success: true,
  },
  {
    contractId: 'log-cid-2',
    policyId: 'policy-001',
    executionId: 'exec-002',
    sender: aliceParty,
    executor: 'executor::1220ff',
    targetStreamId: 'stream-002',
    action: 'Withdraw',
    amount: '0.00',
    executionTime: '2026-02-02T12:00:00.000Z',
    success: false,
    errorMessage: 'rate-limit exceeded',
  },
];

export const fixtures = {
  aliceParty,
  bobParty,
  escrowParty,
  rawStreams,
  rawPendingRequests,
  rawPolicies,
  rawExecutionLogs,
};
