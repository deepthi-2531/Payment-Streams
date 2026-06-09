/**
 * Primitives barrel — Canton Streams UI design system.
 *
 * All primitives are self-contained: they read tokens from CSS custom
 * properties exposed by `src/styles/cc-streams.css` and accept SDK types
 * (`Stream`, `VestingModeConfig`, `StreamStatus`) directly. No mock
 * fixtures touched.
 */

export { Avatar, type AvatarIdentity, type AvatarProps } from './Avatar.js';
export {
  PartyChip,
  partyShort,
  type PartyIdentity,
  type PartyChipProps,
} from './PartyChip.js';
export { MonoCounter, type MonoCounterProps } from './MonoCounter.js';
export { FlowBar, type FlowBarProps } from './FlowBar.js';
export { VestingSparkline, type VestingSparklineProps } from './VestingSparkline.js';
export { AccrualChart, type AccrualChartProps } from './AccrualChart.js';
export { VestingPreview, type VestingPreviewProps } from './VestingPreview.js';
export { StatusBadge, type StatusBadgeProps } from './StatusBadge.js';
export { VestingBadge, type VestingBadgeProps } from './VestingBadge.js';
export { SettlementBadge, type SettlementBadgeProps } from './SettlementBadge.js';
export { Copyable, type CopyableProps } from './Copyable.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';
export { PulseStat, type PulseStatProps } from './PulseStat.js';
export { AssetGlyph, type AssetGlyphProps } from './AssetGlyph.js';
export { Icons, type IconProps } from './Icons.js';
export { useNow } from './useNow.js';
