# Featured-App Rewards (CIP-0047)

How to claim Canton Foundation featured-app rewards for stream
lifecycle events your dApp drives.

CIP-0047 introduces `FeaturedAppActivityMarker` contracts that
applications emit to signal that a transaction added value to the
network. The Canton Foundation reward pool allocates ~62% of validator
rewards to featured-app activity (capped at $1.50 per transaction).

For Canton Payment Streams, this means **every stream lifecycle event**
(Create, Accept, Withdraw, Cancel, Renew, TopUp, Complete) can earn
the operator featured-app credit if you opt in.

---

## Why this matters economically

Stream lifecycle events incur ~$0.50 USD in CC fees (burned). Featured-
app rewards can credit ~$1.50 per event back from the validator
rewards pool. Net: **economically positive for the operator** at scale.

That's the lever that makes the M5 adoption-bonus mechanics work:
high-frequency events (e.g. weekly LP claims, daily infrastructure
withdrawals) are net-positive for adopters even before considering
the underlying business value.

---

## Opting in

The `FeaturedAppActivityMarker` emission is a per-stream config flag.
Add the flag when creating the stream:

```ts
const params = buildIncentiveStream({
  // ... other fields ...
  meta: {
    emitFeaturedAppMarker: true,
    featuredAppKey: 'canton-streams',  // or your dApp's CIP-0047 key
  },
});
```

The corresponding Daml field is set on `StreamConfig` (via the
proposal's choice payload) so the marker is created automatically on
each lifecycle event.

---

## Registering your dApp

To earn rewards, your dApp must be registered as a featured-app
provider with the Canton Foundation. The registration flow is outside
the scope of this library — see CIP-0047 documentation on the Canton
Foundation site for the current process.

Once registered, you receive a featured-app key that you pass into
the stream config via the `featuredAppKey` field.

---

## Verifying rewards

Featured-app rewards are credited to your party identifier as part of
the Canton Foundation's reward distribution cycle. The library does
not handle the reward claim itself — only the marker emission.

To audit which of your streams earned featured-app credit, query the
Scan endpoint for `FeaturedAppActivityMarker` contracts where the
provider party matches your dApp's registered key.

---

## Opting out

Featured-app marker emission is opt-in. If you do not want to claim
rewards (e.g. for privacy reasons), simply omit the
`emitFeaturedAppMarker` flag — no markers will be emitted, no rewards
will be claimed, and the stream operates identically otherwise.