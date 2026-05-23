/**
 * StreamsTable — Phase 8 / STR-119.
 *
 * Smoke-level rendering: empty-state path + a populated rows path.
 * We construct Stream objects directly (not via the API hooks) so the
 * test focuses on render logic, not data wiring.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Decimal from 'decimal.js';
import {
  AssetType,
  SettlementMode,
  StreamStatus,
  VestingMode,
  type Stream,
} from '@canton-streams/sdk/browser';
import { StreamsTable } from './StreamsTable.js';

function mkStream(over: Partial<Stream> = {}): Stream {
  return {
    contractId: 'cid-1',
    config: {
      streamId: 'stream-001-very-long-id',
      sender: 'alice::1220abcdef',
      recipient: 'bob::1220beefcafe',
      totalDeposited: new Decimal(1000),
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-12-31T00:00:00Z'),
      vestingMode: { mode: VestingMode.Linear },
      assetType: AssetType.GlobalCip56,
      settlementMode: SettlementMode.UtilityHoldingCustody,
      cancellable: true,
      ...over.config,
    },
    state: {
      totalWithdrawn: new Decimal(250),
      status: StreamStatus.Active,
      renewalCount: 0,
      ...over.state,
    },
    ...over,
  } as Stream;
}

describe('<StreamsTable />', () => {
  it('renders the empty state when no streams are provided', () => {
    render(
      <MemoryRouter>
        <StreamsTable streams={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no streams found/i)).toBeInTheDocument();
  });

  it('renders header + one row per stream', () => {
    const streams = [mkStream(), mkStream({ contractId: 'cid-2' })];
    render(
      <MemoryRouter>
        <StreamsTable streams={streams} />
      </MemoryRouter>,
    );

    // Header
    expect(screen.getByText('Stream id / parties')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByText('Settlement')).toBeInTheDocument();

    // Two rows linking to the detail page
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2);
    expect(links[0]?.getAttribute('href')).toMatch(/\/streams\//);
  });

  it('shows the truncated stream id + vesting badge on each row', () => {
    render(
      <MemoryRouter>
        <StreamsTable streams={[mkStream()]} />
      </MemoryRouter>,
    );
    // First 14 chars + ellipsis
    expect(screen.getByText(/stream-001-ver/)).toBeInTheDocument();
    expect(screen.getByText(VestingMode.Linear)).toBeInTheDocument();
  });
});
