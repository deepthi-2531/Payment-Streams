/**
 * @module signing/adapters/dfns
 *
 * Dfns-backed signing provider. Keys managed by Dfns' MPC
 * infrastructure with programmable policy controls.
 *
 * Gateway-side env vars (per upstream docs):
 *   - DFNS_ORG_ID      — Dfns organization id
 *   - DFNS_BASE_URL    — Dfns API URL (defaults to `https://api.dfns.io`)
 *   - DFNS_CRED_ID     — service account credential id
 *   - DFNS_PRIVATE_KEY — service account private key (PEM)
 *   - DFNS_AUTH_TOKEN  — service account auth token
 *
 * Per upstream Dfns docs: only `Canton` and `CantonTestnet` network
 * wallets are supported. The gateway handles validator integration;
 * the SDK just calls JSON-RPC.
 */

import { BaseSigningProvider } from './base.js';
import type { SigningProviderKind, GatewayConnection } from '../provider.js';

export interface DfnsAdapterOptions {
  readonly warnOnMissingProvider?: boolean;
}

export class DfnsSigningProvider extends BaseSigningProvider {
  readonly kind: SigningProviderKind = 'dfns';

  constructor(
    connection: GatewayConnection,
    private readonly options: DfnsAdapterOptions = {},
  ) {
    super(connection);
  }

  async verifyProviderAvailable(): Promise<boolean> {
    const accounts = await this.listAccounts();
    const hasDfns = accounts.some((w) => w.signingProviderId === 'dfns');
    if (!hasDfns && this.options.warnOnMissingProvider !== false) {
      // eslint-disable-next-line no-console
      console.warn(
        '[canton-streams] Gateway at',
        this.connection.gatewayUrl,
        'reports no wallets bound to Dfns. Verify DFNS_ORG_ID/DFNS_CRED_ID/DFNS_PRIVATE_KEY/DFNS_AUTH_TOKEN are configured at the gateway.',
      );
    }
    return hasDfns;
  }
}
