/**
 * @module types/config
 *
 * Client configuration for connecting to a Canton participant node.
 */

/**
 * Configuration for establishing a connection to the Canton Ledger API.
 */
export interface ClientConfig {
  /** Hostname or IP address of the Canton participant node. */
  readonly host: string;

  /** gRPC port of the Ledger API (typically 6865). */
  readonly port: number;

  /** Whether to establish a TLS-secured connection. */
  readonly useTls: boolean;

  /**
   * [H-4] Acknowledge sending a bearer token over a plaintext channel to
   * a non-loopback host. The SDK refuses to do so by default because the
   * token is sniffable/replayable on the wire. Only set this for a
   * trusted private network where TLS termination happens at a sidecar.
   * Loopback hosts (localhost/127.0.0.1/::1) never require it.
   */
  readonly allowInsecureToken?: boolean;

  /**
   * JWT bearer token for authentication.
   * Required when the participant enforces token-based auth.
   */
  readonly token?: string;

  /**
   * PEM-encoded CA certificate for TLS verification.
   * When provided, enables server certificate verification against this CA.
   * Required for mTLS setups.
   */
  readonly caCert?: Buffer;

  /**
   * Canton parties to act as when submitting commands.
   * At least one party is required.
   */
  readonly actAs: string[];

  /**
   * Additional Canton parties whose contracts may be read.
   * Defaults to the same set as `actAs` when omitted.
   */
  readonly readAs?: string[];

  /**
   * Canton synchronizer (domain) ID for command submission.
   * Required on multi-synchronizer deployments (e.g. Canton Network devnet).
   * When set, the SDK includes `synchronizer_id` in every command submission.
   */
  readonly synchronizerId?: string;

  /**
   * Minimum log level for SDK internal logging.
   * Defaults to 'info'.
   */
  readonly logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

  /**
   * Transport mode: 'grpc' (default, Node.js only) or 'json-api' (browser-safe).
   *
   * When set to 'json-api', the SDK uses the Canton JSON API (HTTP) instead of
   * gRPC. This enables direct browser-to-ledger access without a proxy server.
   *
   * Limitations of json-api mode:
   * - No streaming (getUpdates unavailable — history falls back to state synthesis)
   * - No offset tracking on query results
   */
  readonly transportMode?: 'grpc' | 'json-api';

  /**
   * Canton JSON API base URL (e.g. "http://localhost:7575").
   * Required when transportMode is 'json-api'.
   */
  readonly jsonApiUrl?: string;

  /**
   * Canton user ID for command submission.
   * Required by Canton v2 when HS256 JWT auth is used.
   * If not set, defaults to the first actAs party's display name (before ::).
   */
  readonly userId?: string;
}
