/**
 * Backwards-compat re-export. Original implementation lived here pre-STR-111
 * and used recharts; it's now provided by the Canton Streams design system
 * primitive at `components/primitives/AccrualChart` which uses native SVG +
 * the SDK accrual formulas via `lib/accrualAt`.
 *
 * The new primitive's prop shape is a strict superset of the legacy one
 * (`{ stream, points? }` plus optional `height` and `liveTick`) — direct
 * re-export is safe; no caller-side changes required.
 *
 * Callers should import directly from the primitive going forward:
 *
 *   import { AccrualChart } from '@/components/primitives';
 *
 * This shim stays through Phase 5; deletion candidate post-Phase 5 once all
 * call sites are migrated.
 */
export { AccrualChart } from '../primitives/AccrualChart.js';
export type { AccrualChartProps } from '../primitives/AccrualChart.js';
