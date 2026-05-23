import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createReadinessConfig,
  extractPackageVettedState,
  parseBoolean,
} from '../dist/readiness.js';

test('extractPackageVettedState treats registered packages as not vetted', () => {
  assert.equal(extractPackageVettedState({ packageStatus: 'PACKAGE_STATUS_REGISTERED' }), false);
  assert.equal(extractPackageVettedState({ status: 'registered' }), false);
});

test('extractPackageVettedState detects explicit vetted booleans and nested tokens', () => {
  assert.equal(extractPackageVettedState({ vetted: true }), true);
  assert.equal(extractPackageVettedState({ result: { packageStatus: { isVetted: false } } }), false);
  assert.equal(extractPackageVettedState({ message: 'package is vetted on the synchronizer' }), true);
});

test('createReadinessConfig falls back to configured streams package IDs', () => {
  const config = createReadinessConfig({
    CANTON_STREAMS_PACKAGE_ID: 'main-package',
    CANTON_STREAMS_TOKEN_STANDARD_PACKAGE_ID: 'token-package',
    PROXY_STARTUP_REQUIRE_VETTED_PACKAGES: 'true',
  }, 'service-token');

  assert.deepEqual(config.requiredPackageIds, ['main-package', 'token-package']);
  assert.equal(config.requireVettedPackages, true);
  assert.equal(config.token, 'service-token');
});

test('createReadinessConfig prefers explicit required package ids', () => {
  const config = createReadinessConfig({
    CANTON_STREAMS_PACKAGE_ID: 'main-package',
    PROXY_STARTUP_REQUIRED_PACKAGE_IDS: 'first, second , first',
  });

  assert.deepEqual(config.requiredPackageIds, ['first', 'second']);
});

test('parseBoolean understands common truthy and falsy values', () => {
  assert.equal(parseBoolean('true', false), true);
  assert.equal(parseBoolean('off', true), false);
  assert.equal(parseBoolean(undefined, true), true);
});
