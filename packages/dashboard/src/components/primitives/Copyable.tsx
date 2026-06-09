/**
 * Copyable — monospaced clickable value that copies to clipboard on click.
 *
 * Shows a check icon for 1.2s after a successful copy.
 */
import { useState, type MouseEvent } from 'react';
import { Icons } from './Icons.js';

export interface CopyableProps {
  readonly value: string;
  readonly display?: string;
  readonly size?: number;
}

export function Copyable({ value, display, size = 12 }: CopyableProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }
  };

  return (
    <button
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 6px',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: size,
        color: 'var(--fg-3)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--card-2)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
      title={value}
    >
      {display ?? value}
      {copied ? <Icons.Check size={11} /> : <Icons.Copy size={11} />}
    </button>
  );
}
