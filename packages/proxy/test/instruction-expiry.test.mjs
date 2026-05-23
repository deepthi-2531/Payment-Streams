// STR-98 — instruction-expiry scheduling tests for the V2 transfer-events
// subscriber. Verifies:
//   - scheduleInstructionExpiry fires an `instruction:expired` event
//     when wall-clock crosses expiresAt
//   - rescheduling the same instructionCid cancels the prior timer
//   - cancel() handle prevents the event from firing
//   - subscriber.stop() cancels all pending TTL timers

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { setTimeout as wait } from 'node:timers/promises';

import { createSubscriber } from '../dist/transfer-events-subscriber.js';

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function makeSubscriber() {
  return createSubscriber({
    ledgerApiUrl: 'http://test/',
    assets: [],
    packageHashes: [],
    subscribeAs: [],
    logger: silentLogger(),
  });
}

test('scheduleInstructionExpiry fires instruction:expired after TTL elapses', async () => {
  const sub = makeSubscriber();
  let fired = null;
  sub.on('instruction:expired', (event) => { fired = event; });

  const expiresAt = new Date(Date.now() + 50);
  sub.scheduleInstructionExpiry({
    instructionCid: 'inst-001',
    assetKey: 'cc',
    instructionKind: 'transfer',
    expiresAt,
  });

  await wait(100);
  assert.ok(fired, 'instruction:expired should have fired');
  assert.equal(fired.instructionCid, 'inst-001');
  assert.equal(fired.assetKey, 'cc');
  assert.equal(fired.instructionKind, 'transfer');
  assert.equal(fired.version, 'v2');
  assert.equal(fired.expiredAt.getTime(), expiresAt.getTime());
});

test('rescheduling the same cid cancels the prior timer', async () => {
  const sub = makeSubscriber();
  let fireCount = 0;
  sub.on('instruction:expired', () => { fireCount++; });

  // First schedule with very short TTL.
  sub.scheduleInstructionExpiry({
    instructionCid: 'inst-002',
    assetKey: 'cc',
    instructionKind: 'allocation',
    expiresAt: new Date(Date.now() + 50),
  });
  // Reschedule before the first fires, with a longer TTL.
  sub.scheduleInstructionExpiry({
    instructionCid: 'inst-002',
    assetKey: 'cc',
    instructionKind: 'allocation',
    expiresAt: new Date(Date.now() + 200),
  });

  // After 100ms only the rescheduled (longer) timer should be active.
  // The original shorter timer must have been cancelled.
  await wait(120);
  assert.equal(fireCount, 0, 'rescheduled timer must cancel the original');

  // After full TTL, exactly one event should have fired.
  await wait(150);
  assert.equal(fireCount, 1, 'rescheduled timer should fire exactly once');
});

test('cancel() handle prevents the event from firing', async () => {
  const sub = makeSubscriber();
  let fired = false;
  sub.on('instruction:expired', () => { fired = true; });

  const handle = sub.scheduleInstructionExpiry({
    instructionCid: 'inst-003',
    assetKey: 'cc',
    instructionKind: 'transfer',
    expiresAt: new Date(Date.now() + 50),
  });
  handle.cancel();

  await wait(100);
  assert.equal(fired, false, 'cancelled timer must not fire');
});

test('stop() cancels all pending TTL timers', async () => {
  const sub = makeSubscriber();
  let fireCount = 0;
  sub.on('instruction:expired', () => { fireCount++; });

  for (let i = 0; i < 5; i++) {
    sub.scheduleInstructionExpiry({
      instructionCid: `inst-stop-${i}`,
      assetKey: 'cc',
      instructionKind: 'transfer',
      expiresAt: new Date(Date.now() + 100),
    });
  }
  await sub.stop();
  await wait(150);
  assert.equal(fireCount, 0, 'all TTL timers must be cancelled on stop()');
});

test('past expiresAt fires on next tick', async () => {
  const sub = makeSubscriber();
  let fired = null;
  sub.on('instruction:expired', (event) => { fired = event; });

  sub.scheduleInstructionExpiry({
    instructionCid: 'inst-past',
    assetKey: 'cc',
    instructionKind: 'allocation',
    expiresAt: new Date(Date.now() - 1000),  // already past
  });

  await wait(20);
  assert.ok(fired, 'past expiry should fire on next tick');
  assert.equal(fired.instructionCid, 'inst-past');
});
