/**
 * @module helpers
 *
 * High-level facades over the canonical streaming use cases:
 *
 *   - vesting (employee / advisor / investor unlock schedules)
 *   - LP incentives (liquidity-provider reward campaigns)
 *   - validator billing (recurring + usage-based infrastructure billing)
 *
 * dApps that want default-parameter constructors should import from
 * here rather than assembling `CreateStreamParams` from scratch.
 */

export {
  buildVestingStream,
  type VestingStreamOptions,
  type VestingStyle,
} from './vesting.js';

export {
  buildIncentiveStream,
  type IncentiveStreamOptions,
} from './lpIncentives.js';

export {
  buildRecurringBillingStream,
  buildUsageBillingFlow,
  type RecurringBillingOptions,
  type UsageBillingFlowOptions,
  type FlowCreateParams,
} from './validatorBilling.js';
