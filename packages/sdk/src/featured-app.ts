/**
 * @module featured-app
 *
 * SDK surface for transitional CIP-0047 FeaturedAppActivity integration.
 *
 * Pairs with the Daml module `CantonStreams.FeaturedApp.Activity` —
 * adopters opt in by attaching a `FeaturedAppConfig` to their stream
 * creation, and the SDK's settlement orchestrator emits per-lifecycle
 * markers automatically.
 *
 * See `docs/integration-guide/featured-app-rewards.md` for the full
 * adopter walkthrough.
 */

import Decimal from 'decimal.js';

/** Lifecycle activity categories — mirrors the Daml `ActivityType`. */
export type ActivityType =
  | 'create'
  | 'accept'
  | 'withdraw'
  | 'cancel'
  | 'renew'
  | 'topUp'
  | 'complete'
  | 'milestoneConfirm';

/** Per-stream featured-app emission configuration. */
export interface FeaturedAppConfig {
  /** True iff this stream emits featured-app markers on lifecycle events. */
  readonly enabled: boolean;
  /**
   * Featured-app key issued by the program administrator upon CIP-0047
   * registration. Empty string when `enabled = false`.
   */
  readonly featuredAppKey: string;
}

/** Default — featured-app emission disabled. */
export function disabledFeaturedApp(): FeaturedAppConfig {
  return { enabled: false, featuredAppKey: '' };
}

/** Construct an enabled config for a registered featured-app key. */
export function enabledFeaturedApp(featuredAppKey: string): FeaturedAppConfig {
  if (!featuredAppKey || featuredAppKey.trim() === '') {
    throw new Error('enabledFeaturedApp requires a non-empty featuredAppKey');
  }
  return { enabled: true, featuredAppKey };
}

/**
 * One emission record per stream lifecycle event. Produced by the
 * settlement orchestrator when the stream is opt-in for featured-app
 * activity. The orchestrator forwards the emission to the Daml side
 * for actual `FeaturedAppActivityMarker` creation.
 */
export interface FeaturedAppEmission {
  readonly featuredAppKey: string;
  readonly activityType: ActivityType;
  readonly amount: Decimal;
  readonly streamId: string;
  readonly participant: string;
  readonly meta?: string;
}

export interface FeaturedAppRewardEstimateOptions {
  /**
   * Current reward cap for the target network, supplied by the caller
   * after checking the active network reward regime.
   */
  readonly rewardCapUsd?: Decimal | string | number;
}

/**
 * Construct an emission record. Returns `undefined` if the config has
 * emission disabled — callers should check the return and skip the
 * Daml-side emission if undefined.
 */
export function buildEmission(
  config: FeaturedAppConfig,
  activityType: ActivityType,
  amount: Decimal | string | number,
  streamId: string,
  participant: string,
  meta?: string,
): FeaturedAppEmission | undefined {
  if (!config.enabled) return undefined;
  return {
    featuredAppKey: config.featuredAppKey,
    activityType,
    amount: new Decimal(amount),
    streamId,
    participant,
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * Estimate the per-tx featured-app reward only when the caller provides
 * the active network's reward cap.
 *
 * CIP-0047 is expected to be phased out once CIP-0104 goes live, and
 * the economics can change by network and date. Returning `undefined`
 * without an explicit cap prevents dashboards from baking stale
 * `$1.50/event` assumptions into budgets.
 */
export function estimateRewardCapUsd(
  _activityType: ActivityType,
  options: FeaturedAppRewardEstimateOptions = {},
): Decimal | undefined {
  return options.rewardCapUsd === undefined ? undefined : new Decimal(options.rewardCapUsd);
}
