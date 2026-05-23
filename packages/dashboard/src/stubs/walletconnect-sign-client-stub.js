/**
 * Empty stub for @walletconnect/sign-client.
 *
 * @canton-network/dapp-sdk declares @walletconnect/sign-client as an
 * OPTIONAL peerDependency (peerDependenciesMeta.optional = true). Vite's
 * dep-optimizer is too strict and fails the whole module graph when it
 * can't resolve an optional peer, even though the runtime branch that
 * needs WalletConnect only fires when the user picks the WalletConnect
 * provider in the wallet picker.
 *
 * This stub lets the build succeed. Any actual call into the stub will
 * fall through a Proxy that no-ops, so the *load* path works and the
 * dashboard only crashes if a user actively tries to use WalletConnect.
 * For the dev-credential smoke (Streams-Sender JWT paste) we never go
 * down that branch.
 *
 * To get real WalletConnect support, install @walletconnect/sign-client
 * via the workspace and remove the resolve.alias entry in vite.config.ts.
 */
const noop = new Proxy(function () {}, {
  get: () => noop,
  apply: () => noop,
  construct: () => noop,
});

export const SignClient = noop;
export default noop;
