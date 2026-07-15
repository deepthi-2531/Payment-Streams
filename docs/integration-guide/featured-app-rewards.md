# Featured-App Rewards (CIP-0047) — emission helper

> **Status:** CIP-0047 featured-app rewards are transitional and may be replaced by **CIP-0104** at the network level. Treat any specific reward-per-event number you see in older Canton docs as fragile — confirm what's actually in force on your target network before you bake reward assumptions into a budget.
>
> This library provides a thin **emission helper** so adopters who opt in can mark stream lifecycle events with `FeaturedAppActivityMarker` contracts during the CIP-0047 window. It does not pay rewards itself, and it does not promise any particular reward amount.

## What the library does

The `FeaturedAppActivity` Daml module
(`packages/daml/main/daml/CantonStreams/FeaturedApp/Activity.daml`)
builds the marker-emission record that an integration can use to emit
`FeaturedAppActivityMarker` contracts when the target network still
supports the CIP-0047 marker path.

## What the library does not do

- Register your dApp as a featured-app provider with the relevant network program.
- Claim or distribute rewards.
- Guarantee any reward amount, eligibility, or schedule.
- Track CIP-0104 transition state (you must do this yourself).

## Opting in

Opt in per stream, after confirming the active reward/marker regime
for the target network:

```ts
import { enabledFeaturedApp, buildEmission } from '@canton-streams/sdk';
import { buildIncentiveStream } from '@canton-streams/sdk/helpers';

const params = buildIncentiveStream({ /* ... campaign fields ... */ });

// Opt in with the key from your CIP-0047 program registration
const featuredApp = enabledFeaturedApp('your-cip-0047-key');

// On each lifecycle event, build the marker emission record.
// Returns undefined when emission is disabled.
const emission = buildEmission(
  featuredApp, 'create', params.totalDeposited, params.streamId, operatorParty,
);
```

The config is opt-in. Default behaviour emits no markers. The SDK does
not provide a default reward projection; callers must supply current
network economics explicitly if they choose to show projections.

## Where to verify the current state

- [CIP-0047 spec](https://github.com/canton-foundation/cips/blob/main/cip-0047/cip-0047.md)
- [CIP-0104 spec](https://github.com/canton-foundation/cips/blob/main/cip-0104/cip-0104.md)
- Network announcements for the active reward regime and any transition window

## Migration to CIP-0104

CIP-0047's featured-app marker mechanism may be replaced by [CIP-0104](https://github.com/canton-foundation/cips/blob/main/cip-0104/cip-0104.md) at the network level. When that lands:

1. **`FeaturedAppActivityMarker` emission may be deprecated.** Adopters who registered as CIP-0047 featured-app providers should confirm whether their CIP-0047 markers continue to be rewarded during any transition window, and what the CIP-0104 equivalent looks like (it may be a different marker type, a different scoring model, or a different registration flow).
2. **`FeaturedAppConfig` may be renamed.** If CIP-0104 introduces a different marker shape, this SDK module will either grow a parallel CIP-0104 config type or be replaced. The current SDK API is opt-in and disabled by default, so existing integrations that don't enable it are unaffected.
3. **`estimateRewardCapUsd` will stay caller-supplied.** The function returns `undefined` when no `rewardCapUsd` is passed, which keeps dashboards from baking stale reward assumptions into projections. This pattern carries forward to whatever CIP-0104 introduces.

The library will track CIP-0104 support under a future minor release; see [CHANGELOG.md](../../CHANGELOG.md) for the entry. Until then, treat CIP-0047 as transitional, and treat any economic projection as caller-supplied rather than library-supplied. The specs and network announcements above under [Where to verify the current state](#where-to-verify-the-current-state) are the source of truth for the active reward regime.
