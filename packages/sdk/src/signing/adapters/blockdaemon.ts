/**
 * @module signing/adapters/blockdaemon
 *
 * Blockdaemon-backed signing provider. Keys held by Blockdaemon's
 * infrastructure; the gateway calls Blockdaemon's API.
 *
 * Gateway-side env vars (per upstream docs):
 *   - BLOCKDAEMON_API_URL
 *   - BLOCKDAEMON_API_KEY
 */

import { BaseSigningProvider } from './base.js';
import type { SigningProviderKind, GatewayConnection } from '../provider.js';

export interface BlockdaemonAdapterOptions {
  readonly warnOnMissingProvider?: boolean;
}

export class BlockdaemonSigningProvider extends BaseSigningProvider {
  readonly kind: SigningProviderKind = 'blockdaemon';

  constructor(
    connection: GatewayConnection,
    private readonly options: BlockdaemonAdapterOptions = {},
  ) {
    super(connection);
  }

  async verifyProviderAvailable(): Promise<boolean> {
    const accounts = await this.listAccounts();
    const hasBlockdaemon = accounts.some(
      (w) => w.signingProviderId === 'blockdaemon',
    );
    if (!hasBlockdaemon && this.options.warnOnMissingProvider !== false) {
       
      console.warn(
        '[canton-streams] Gateway at',
        this.connection.gatewayUrl,
        'reports no wallets bound to Blockdaemon. Verify BLOCKDAEMON_API_URL + BLOCKDAEMON_API_KEY are configured at the gateway.',
      );
    }
    return hasBlockdaemon;
  }
}
