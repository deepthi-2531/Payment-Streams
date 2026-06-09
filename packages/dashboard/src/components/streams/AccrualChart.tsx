/**
 * Backwards-compatible re-export for the design-system AccrualChart.
 *
 * The new primitive's prop shape is a strict superset of the legacy one
 * (`{ stream, points? }` plus optional `height` and `liveTick`) — direct
 * re-export is safe; no caller-side changes required.
 *
 * Callers should import directly from the primitive going forward:
 *
 *   import { AccrualChart } from '@/components/primitives';
 */
export { AccrualChart } from '../primitives/AccrualChart.js';
export type { AccrualChartProps } from '../primitives/AccrualChart.js';
