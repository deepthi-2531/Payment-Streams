/**
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

type Over = {
  contractId?: string;
  config?: Partial<Stream['config']>;
  state?: Partial<Stream['state']>;
};

function mkStream(over: Over = {}): Stream {
  const { config: cfgOver, state: stOver, ...rest } = over;
  return {
    contractId: 'cid-1',
    ...rest,
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
      ...cfgOver,
    },
    state: {
      totalWithdrawn: new Decimal(250),
      status: StreamStatus.Active,
      renewalCount: 0,
      ...stOver,
    },
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

  it('renders the header and one row per stream', () => {
    const streams = [
      mkStream(),
      mkStream({ contractId: 'cid-2', config: { streamId: 'stream-002-very-long-id' } }),
    ];
    render(
      <MemoryRouter>
        <StreamsTable streams={streams} />
      </MemoryRouter>,
    );

    // Header — people and money, not raw ids or an internal settlement mode.
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();

    // Two rows linking to the detail page.
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2);
    expect(links[0]?.getAttribute('href')).toMatch(/\/streams\//);
  });

  it('shows readable names and amounts, not raw ids or jargon', () => {
    render(
      <MemoryRouter>
        <StreamsTable streams={[mkStream()]} />
      </MemoryRouter>,
    );

    // Human short-names, the amount, and progress/status.
    expect(screen.getByText(/alice\s*→\s*bob/)).toBeInTheDocument();
    expect(screen.getByText('1000')).toBeInTheDocument();
    expect(screen.getByText(/25% paid/)).toBeInTheDocument();
    expect(screen.getByText('Streaming')).toBeInTheDocument();

    // The raw stream id, vesting-mode jargon, and settlement label are gone.
    expect(screen.queryByText(/stream-001/)).toBeNull();
    expect(screen.queryByText(VestingMode.Linear)).toBeNull();
    expect(screen.queryByText('CIP Custody')).toBeNull();
  });
});
