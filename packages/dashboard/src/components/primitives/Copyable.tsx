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
  /** Ellipsis-truncate the display text so a long value (e.g. a party id) fits
   * a constrained container; the copy icon stays visible. */
  readonly truncate?: boolean;
  /** Override the display text colour (defaults to the muted `--fg-3`). */
  readonly color?: string;
  /** `chip` (default) is the standalone mono pill; `inline` inherits the
   * surrounding text's font/size/colour so it can sit inside a heading or
   * sentence and only shows the copy icon on hover / after copy. */
  readonly variant?: 'chip' | 'inline';
}

export function Copyable({ value, display, size = 12, truncate, color, variant = 'chip' }: CopyableProps) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }
  };

  const inline = variant === 'inline';
  const iconSize = inline ? Math.max(12, Math.round(size * 0.5)) : 11;
  // In a heading, keep the affordance quiet: reveal the icon on hover/after copy.
  const showIcon = inline ? hover || copied : true;

  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: inline ? 'baseline' : 'center',
        gap: inline ? '0.3em' : 6,
        ...(inline
          ? {
              font: 'inherit',
              color: color ?? 'inherit',
              padding: 0,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              verticalAlign: 'baseline',
            }
          : {
              padding: '2px 6px',
              borderRadius: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: size,
              color: color ?? 'var(--fg-3)',
              background: hover ? 'var(--card-2)' : 'transparent',
            }),
        ...(truncate ? { maxWidth: '100%', minWidth: 0 } : {}),
      }}
      title={copied ? 'Copied' : `Copy ${value}`}
    >
      <span
        style={{
          ...(truncate
            ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
            : {}),
          ...(inline ? { textDecoration: hover ? 'underline' : 'none', textUnderlineOffset: 3 } : {}),
        }}
      >
        {display ?? value}
      </span>
      {showIcon &&
        (copied ? <Icons.Check size={iconSize} /> : <Icons.Copy size={iconSize} />)}
    </button>
  );
}
