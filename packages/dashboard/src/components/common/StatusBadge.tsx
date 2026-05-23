/**
 * Backwards-compat re-export. Original implementation lived here pre-STR-111
 * and used Tailwind brand-* utility classes; it's now provided by the
 * Canton Streams design system primitive at `components/primitives/StatusBadge`.
 *
 * Callers should import directly from the primitive going forward:
 *
 *   import { StatusBadge } from '@/components/primitives';
 *
 * This shim stays through Phase 5; deletion candidate post-Phase 5 once all
 * call sites are migrated.
 */
export { StatusBadge } from '../primitives/StatusBadge.js';
export type { StatusBadgeProps } from '../primitives/StatusBadge.js';
