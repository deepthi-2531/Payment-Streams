/** Wallet-client contract tests. */

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

describe('capability ↔ method consistency', () => {
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
    expect(partyLayerWalletClient.capabilities.openSurfacesWalletUi).toBe(
      false,
    );
    expect(partyLayerWalletClient.capabilities.ledgerApi).toBe(true);
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
