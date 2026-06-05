/**
 * Wallet-client contract tests — STR-130 / STR-131 / STR-132.
 *
 * Locks the small set of guarantees the abstraction makes about each
 * concrete client. The full PartyLayer connect/disconnect/sign flow
 * is exercised in the live hosted-wallet E2E (STR-133); here we only
 * need to confirm:
 *
 *   1. Both clients expose the StreamsWalletClient surface
 *      (no method on the contract is `undefined`).
 *   2. Capability bags are consistent with each layer's role —
 *      dapp-sdk = single-wallet, hostedMultiWallet=false;
 *      partylayer = hostedMultiWallet=true, openSurfacesWalletUi=false.
 *   3. Call sites that rely on `capabilities.prepareExecuteAndWait`
 *      to gate the future AllocationRequest-accept swap can check it
 *      WITHOUT reaching for the method's `typeof`.
 */

import { describe, expect, it } from 'vitest';
import { dappSdkWalletClient } from './dappSdkClient.js';
import { partyLayerWalletClient } from './partyLayerClient.js';
import type { StreamsWalletClient } from './types.js';

const CONTRACT_METHODS: Array<keyof StreamsWalletClient> = [
  'init',
  'connect',
  'disconnect',
  'status',
  'listAccounts',
  'open',
  'describeConnectError',
  'onStatusChanged',
  'onAccountsChanged',
  'onConnected',
  'onTxChanged',
  'removeOnStatusChanged',
  'removeOnAccountsChanged',
  'removeOnConnected',
  'removeOnTxChanged',
];

describe('StreamsWalletClient contract — dapp-sdk', () => {
  it('exposes every required method on the contract', () => {
    for (const k of CONTRACT_METHODS) {
      expect(typeof dappSdkWalletClient[k]).toBe('function');
    }
  });

  it('claims the single-wallet capability shape', () => {
    expect(dappSdkWalletClient.layer).toBe('dapp-sdk');
    expect(dappSdkWalletClient.supportsHostedMultiWallet).toBe(false);
    expect(dappSdkWalletClient.capabilities.hostedMultiWallet).toBe(false);
    expect(dappSdkWalletClient.capabilities.openSurfacesWalletUi).toBe(true);
    expect(dappSdkWalletClient.capabilities.ledgerApi).toBe(true);
    expect(dappSdkWalletClient.capabilities.prepareExecuteAndWait).toBe(true);
    expect(dappSdkWalletClient.capabilities.v2AllocationRequestUx).toBe(true);
  });

  it('defines optional ledgerApi + prepareExecuteAndWait when capabilities say so', () => {
    expect(typeof dappSdkWalletClient.ledgerApi).toBe('function');
    expect(typeof dappSdkWalletClient.prepareExecuteAndWait).toBe('function');
  });
});

describe('capability ↔ method consistency (STR-132 contract)', () => {
  // The point of the capability bag is that call-sites do not have
  // to sniff `typeof method === 'function'`. These guards lock the
  // invariant: when capability is true, method exists; when false,
  // the method may or may not exist but call-sites must not invoke
  // it. We assert the "if capability=false then method-undefined"
  // direction for partylayer's `prepareExecuteAndWait` because the
  // earlier build claimed the capability AND defined the method —
  // the worst combination, because the method routed to an
  // unsupported CIP-103 method name in the bridge.
  it('partylayer omits prepareExecuteAndWait method now that capability is false', () => {
    expect(partyLayerWalletClient.capabilities.prepareExecuteAndWait).toBe(false);
    expect(partyLayerWalletClient.prepareExecuteAndWait).toBeUndefined();
  });
});

describe('StreamsWalletClient contract — partylayer', () => {
  it('exposes every required method on the contract', () => {
    for (const k of CONTRACT_METHODS) {
      expect(typeof partyLayerWalletClient[k]).toBe('function');
    }
  });

  it('claims the hosted-multi-wallet capability shape', () => {
    expect(partyLayerWalletClient.layer).toBe('partylayer');
    expect(partyLayerWalletClient.supportsHostedMultiWallet).toBe(true);
    expect(partyLayerWalletClient.capabilities.hostedMultiWallet).toBe(true);
    // The picker manages its own visibility — no separate "bring
    // forward" primitive maps to dapp-sdk's `open()`.
    expect(partyLayerWalletClient.capabilities.openSurfacesWalletUi).toBe(
      false,
    );
    expect(partyLayerWalletClient.capabilities.ledgerApi).toBe(true);
    // `@partylayer/provider@0.1.7` does NOT implement
    // `prepareExecuteAndWait` (only `prepareExecute`); the capability
    // is honestly false until upstream adds it.
    expect(partyLayerWalletClient.capabilities.prepareExecuteAndWait).toBe(
      false,
    );
    expect(partyLayerWalletClient.capabilities.v2AllocationRequestUx).toBe(
      true,
    );
  });

  it('exposes listWallets so the dashboard picker can enumerate adapters', () => {
    expect(typeof partyLayerWalletClient.listWallets).toBe('function');
  });

  it('translates a user-rejected error into actionable copy', async () => {
    const msg = await partyLayerWalletClient.describeConnectError(
      new Error('UserRejectedError: user rejected the connection'),
    );
    expect(msg).toMatch(/declined the wallet connection/i);
    expect(msg).toMatch(/Connect wallet/i);
  });

  it('translates a wallet-not-installed error into actionable copy', async () => {
    const msg = await partyLayerWalletClient.describeConnectError(
      new Error('WalletNotInstalledError: wallet not installed'),
    );
    expect(msg).toMatch(/Pick a different wallet/i);
  });
});
