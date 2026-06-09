/**
 * Smoke-level coverage of the two query-state primitives every page
 * leans on.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Skeleton, ErrorState } from './index.js';

describe('<Skeleton.Row />', () => {
  it('renders the requested number of rows', () => {
    const { container } = render(<Skeleton.Row count={3} height={40} />);
    // Use the live-stripe class as the row marker.
    const rows = container.querySelectorAll('.live-stripe');
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('<Skeleton.Card />', () => {
  it('renders a card with the live-stripe class', () => {
    const { container } = render(<Skeleton.Card />);
    expect(container.querySelector('.live-stripe')).toBeInTheDocument();
  });
});

describe('<ErrorState />', () => {
  it('shows the supplied title + error message', () => {
    render(
      <ErrorState
        title="Could not load streams"
        error={new Error('boom')}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByText('Could not load streams'),
    ).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('invokes onRetry when the retry button is clicked', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Failed"
        error={new Error('x')}
        onRetry={onRetry}
      />,
    );
    const button = screen.getByRole('button', { name: /retry/i });
    await userEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
