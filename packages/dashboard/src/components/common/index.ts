/**
 * Barrel for `components/common/*`.
 *
 * `Skeleton` / `LoadingState` / `ErrorState` are the standardized
 * query-state primitives. `ErrorBoundary` is the React error boundary
 * already wired at the App level. `StatusBadge` is a re-export shim
 * kept for backwards-compatible call sites; new code should import from
 * `@/components/primitives`.
 */
export { Skeleton, type SkeletonProps, type SkeletonRowProps } from './Skeleton.js';
export { LoadingState, type LoadingStateProps } from './LoadingState.js';
export { ErrorState, type ErrorStateProps } from './ErrorState.js';
export { ErrorBoundary } from './ErrorBoundary.js';
export { StatusBadge } from './StatusBadge.js';
export {
  PageHeader,
  SectionHeader,
  type PageHeaderProps,
  type SectionHeaderProps,
} from './PageHeader.js';
export { Modal, type ModalProps } from './Modal.js';
