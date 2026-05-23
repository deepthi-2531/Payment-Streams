/**
 * @module signing/adapters/internal-gateway
 *
 * "Wallet Gateway Internal" signing provider — keys stored in the
 * gateway's signing-store database. **Dev/test only**; not for
 * production use cases.
 *
 * Per upstream docs:
 *   > Private keys are stored in the database. If the database is
 *   > compromised, all keys are at risk. Use only in non-production
 *   > environments.
 *
 * Auto-available when the gateway is configured with a `signingStore`.
 * No additional setup at the SDK side.
 *
 * Production safety guard: this adapter refuses to instantiate when
 * NODE_ENV=production unless `ALLOW_INTERNAL_SIGNING_IN_PRODUCTION=true`
 * is also set (escape hatch for sandboxes that run with NODE_ENV=production
 * but explicitly want the internal provider).
 */

import { BaseSigningProvider } from './base.js';
import type { SigningProviderKind, GatewayConnection } from '../provider.js';
import { SigningError, SigningErrorCode } from '../provider.js';

export interface InternalGatewayAdapterOptions {
  /**
   * Bypass the NODE_ENV=production guard. Default false. Only set true
   * if you understand the security implications (see module-level docs).
   */
  readonly allowInProduction?: boolean;
}

export class WalletGatewayInternalSigningProvider extends BaseSigningProvider {
  readonly kind: SigningProviderKind = 'wallet-gateway-internal';

  constructor(
    connection: GatewayConnection,
    options: InternalGatewayAdapterOptions = {},
  ) {
    super(connection);
    const env = process.env['NODE_ENV'];
    const escape = process.env['ALLOW_INTERNAL_SIGNING_IN_PRODUCTION'] === 'true';
    if (env === 'production' && !options.allowInProduction && !escape) {
      throw new SigningError({
        code: SigningErrorCode.UNAUTHORIZED,
        message:
          'WalletGatewayInternalSigningProvider is dev/test only. ' +
          'NODE_ENV=production detected. Set ALLOW_INTERNAL_SIGNING_IN_PRODUCTION=true ' +
          'or pass { allowInProduction: true } if you really mean this (NOT RECOMMENDED — ' +
          'keys live in the gateway DB, vulnerable to DB compromise).',
        kind: this.kind,
      });
    }
  }
}
