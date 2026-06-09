/**
 * Avatar — gradient circular monogram derived from a hue.
 *
 * Initials come from the identity's `name` or `handle`; the gradient uses
 * `hue` / `avatarHue` if present, falling back to 200 (neutral cyan).
 */
import type { CSSProperties } from 'react';

export interface AvatarIdentity {
  readonly name?: string;
  readonly handle?: string;
  readonly hue?: number;
  readonly avatarHue?: number;
}

export interface AvatarProps {
  readonly identity?: AvatarIdentity | null;
  readonly size?: number;
  readonly ring?: boolean;
}

export function Avatar({ identity, size = 28, ring = false }: AvatarProps) {
  const initials = (identity?.name ?? identity?.handle ?? '?')
    .split(/[\s.\-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();
  const hue = identity?.hue ?? identity?.avatarHue ?? 200;

  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, oklch(0.72 0.14 ${hue}), oklch(0.50 0.12 ${(hue + 40) % 360}))`,
    color: '#06080d',
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
    fontSize: size * 0.4,
    flexShrink: 0,
    boxShadow: ring
      ? `0 0 0 2px var(--card), 0 0 0 3px oklch(0.72 0.14 ${hue} / 0.4)`
      : 'none',
  };

  return <div style={style}>{initials}</div>;
}
