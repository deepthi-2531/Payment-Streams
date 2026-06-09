/**
 * StatusBadge — color-coded stream lifecycle status.
 *
 * Ported from `Canton Streams/src/primitives.jsx`. The pulse animation
 * on Active streams comes from the `pulse` class in `cc-streams.css`.
 *
 * Shared status badge primitive.
 */
import { Icons } from './Icons.js';

export interface StatusBadgeProps {
  readonly status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (status === 'Active') {
    return (
      <span className="badge accent" style={{ paddingLeft: 6 }}>
        <span className="pulse" />
        Streaming
      </span>
    );
  }
  if (status === 'Pending') {
    return (
      <span className="badge warn">
        <Icons.Clock size={11} /> Pending
      </span>
    );
  }
  if (status === 'Completed') {
    return (
      <span className="badge info">
        <Icons.Check size={11} /> Completed
      </span>
    );
  }
  if (status === 'Cancelled') {
    return (
      <span className="badge danger">
        <Icons.X size={11} /> Cancelled
      </span>
    );
  }
  return <span className="badge">{status}</span>;
}
