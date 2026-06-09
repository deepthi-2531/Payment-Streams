/**
 * PartyChip — handle prominent, fingerprint subtle.
 *
 * Ported from `Canton Streams/src/primitives.jsx`. Renders an Avatar +
 * the handle + a short party fingerprint. The fingerprint is the segment
 * after `::` in a Canton party identifier (e.g. `alice::abc123def...`
 * → `abc123`).
 *
 * Shared party identity chip.
 */
import { Avatar, type AvatarIdentity } from './Avatar.js';

export interface PartyIdentity extends AvatarIdentity {
  readonly party?: string;
}

export interface PartyChipProps {
  readonly identity: PartyIdentity | null | undefined;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly muted?: boolean;
  readonly showFp?: boolean;
  readonly you?: boolean;
}

/**
 * Extract the fingerprint segment from a fully-qualified Canton party id.
 * `alice::abc123def...` → `abc123`. Returns the original up to 16 chars
 * if there's no `::` separator.
 */
function partyShort(partyId: string): string {
  const sep = partyId.indexOf('::');
  if (sep < 0) return partyId.slice(0, 16);
  return partyId.slice(sep + 2, sep + 8);
}

const FONT_SIZES = { sm: 11.5, md: 13, lg: 15 } as const;
const AVATAR_SIZES = { sm: 18, md: 22, lg: 28 } as const;

export function PartyChip({
  identity,
  size = 'md',
  muted = false,
  showFp = true,
  you = false,
}: PartyChipProps) {
  if (!identity) return null;
  const fp = identity.party ? partyShort(identity.party) : null;
  const fontSize = FONT_SIZES[size];
  const avatarSize = AVATAR_SIZES[size];

  return (
    <span
      className="party-chip"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}
    >
      <Avatar identity={identity} size={avatarSize} />
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 6,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize,
            color: muted ? 'var(--fg-2)' : 'var(--fg)',
            fontWeight: 500,
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
          }}
        >
          {identity.handle}
        </span>
        {you && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--accent)',
              fontWeight: 500,
              letterSpacing: '0.04em',
            }}
          >
            YOU
          </span>
        )}
        {showFp && fp && (
          <span
            className="mono"
            style={{
              fontSize: fontSize - 2,
              color: 'var(--fg-4)',
            }}
          >
            ╱{fp}
          </span>
        )}
      </span>
    </span>
  );
}

export { partyShort };
