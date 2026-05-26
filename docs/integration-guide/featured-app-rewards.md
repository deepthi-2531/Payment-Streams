# Featured-App Rewards (CIP-0047) — emission helper

> **Status:** CIP-0047 featured-app rewards are scheduled to be **phased out around end of July** once **CIP-0104** goes live. The reward economics will change with CIP-0104. Treat any specific reward-per-event number you see in older Canton docs as fragile — confirm with the Canton Foundation what's actually in force on your target network before you bake reward assumptions into a budget.
>
> This library provides a thin **emission helper** so adopters who opt in can mark stream lifecycle events with `FeaturedAppActivityMarker` contracts during the CIP-0047 window. It does not pay rewards itself, and it does not promise any particular reward amount.

## What the library does

The `FeaturedAppActivity` Daml template
(`packages/daml/main/daml/CantonStreams/FeaturedApp/Activity.daml`)
emits a `FeaturedAppActivityMarker` on a per-stream basis when the
stream config sets the relevant flags.

## What the library does not do

- Register your dApp as a featured-app provider with the Canton Foundation.
- Claim or distribute rewards.
- Guarantee any reward amount, eligibility, or schedule.
- Track CIP-0104 transition state (you must do this yourself).

## Opting in

Per-stream config flag at create time:

```ts
const params = buildIncentiveStream({
  // ... other fields ...
  meta: {
    emitFeaturedAppMarker: true,
    featuredAppKey: 'your-cip-0047-key', // from your Foundation registration
  },
});
```

The flag is opt-in. Default behaviour emits no markers.

## Where to verify the current state

- [CIP-0047 spec](https://github.com/canton-foundation/cips/blob/main/cip-0047/cip-0047.md)
- [CIP-0104 spec](https://github.com/canton-foundation/cips/blob/main/cip-0104/cip-0104.md)
- Canton Foundation announcements for the active reward regime and any transition window

## Migration to CIP-0104

When CIP-0104 lands, this emission helper will need to be updated to the new mechanism, the per-stream flag may be renamed, and any code that assumed CIP-0047 economics should be revisited. We will track this in the changelog under the release that adds CIP-0104 support.
