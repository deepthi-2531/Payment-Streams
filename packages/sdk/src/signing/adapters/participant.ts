/**
 * @module signing/adapters/participant
 *
 * Canton-participant signing provider — keys held by the participant
 * node's keystore. Always available; requires no additional Gateway
 * configuration beyond a participant node being reachable.
 *
 * Production default for enterprise deployments where the participant
 * node manages keys directly.
 */

import { BaseSigningProvider } from './base.js';
import type { SigningProviderKind } from '../provider.js';

export class ParticipantSigningProvider extends BaseSigningProvider {
  readonly kind: SigningProviderKind = 'participant';
}
