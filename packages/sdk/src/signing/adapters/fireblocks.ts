/**
 * @module signing/adapters/fireblocks
 *
 * Fireblocks-backed signing provider. Keys held by Fireblocks' HSM
 * infrastructure; the gateway calls Fireblocks' API using its
 * configured credentials.
 *
 * Gateway-side env vars (per upstream docs):
 *   - FIREBLOCKS_API_KEY  — from the Fireblocks API users table
 *   - Plus key files placed at the documented path
 *
 * These are configured at the Gateway, not the SDK; the SDK just
 * tags the kind so observability layers can correlate.
 */

import { BaseSigningProvider } from './base.js';
import type { SigningProviderKind, GatewayConnection } from '../provider.js';
import { SigningError, SigningErrorCode } from '../provider.js';

export interface FireblocksAdapterOptions {
  /**
   * Optional client-side warning: if true, log a warning when the
   * configured gateway is reachable but reports no Fireblocks
   * provider configured. Useful for catching mis-routed traffic.
   */
  readonly warnOnMissingProvider?: boolean;
}

export class FireblocksSigningProvider extends BaseSigningProvider {
  readonly kind: SigningProviderKind = 'fireblocks';

  constructor(
    connection: GatewayConnection,
    private readonly options: FireblocksAdapterOptions = {},
  ) {
    super(connection);
  }

  /**
   * Probe the gateway's signing-provider config at construction
   * time. Returns true if Fireblocks is configured; logs a warning
   * if not. Called from `factory.createSigningProvider` when
   * `kind === 'fireblocks'`.
   */
  async verifyProviderAvailable(): Promise<boolean> {
    const accounts = await this.listAccounts().catch((err) => {
      throw new SigningError({
        code: SigningErrorCode.DISCONNECTED,
        message: `Fireblocks adapter could not reach gateway: ${err?.message ?? err}`,
        kind: this.kind,
      });
    });
    const hasFireblocks = accounts.some(
      (w) => w.signingProviderId === 'fireblocks',
    );
    if (!hasFireblocks && this.options.warnOnMissingProvider !== false) {
      // eslint-disable-next-line no-console
      console.warn(
        '[canton-streams] Gateway at',
        this.connection.gatewayUrl,
        'reports no wallets bound to Fireblocks. Verify FIREBLOCKS_API_KEY + key files are configured at the gateway.',
      );
    }
    return hasFireblocks;
  }
}
