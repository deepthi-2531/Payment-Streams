/**
 * @module transport/grpc
 *
 * gRPC Ledger API transport implementation.
 * Connects to a Canton participant node using @grpc/grpc-js and @grpc/proto-loader.
 *
 * This transport speaks the Canton/Daml gRPC Ledger API directly, with no
 * dependency on @daml/ledger or @daml/types. Proto definitions are loaded at
 * construction time via @grpc/proto-loader so that all messages are serialized
 * as proper protobuf on the wire.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { Transport, CreateResult, TemplateId } from './base.js';
import type { ClientConfig } from '../types/config.js';
import { LedgerError, TransportError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Proto loading
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the bundled proto directory.
 * Works for both ESM (__dirname is not available) and CJS builds.
 */
function protoDir(): string {
  const resolveExistingDir = (baseDir: string): string => {
    const candidates = [
      path.resolve(baseDir, '..', 'proto'),
      path.resolve(baseDir, '..', '..', 'proto'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0]!;
  };

  // ESM: derive __dirname from import.meta.url
  // CJS: __dirname is available globally via the bundler
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — import.meta.url exists at runtime in ESM
    const thisFile = fileURLToPath(import.meta.url);
    return resolveExistingDir(path.dirname(thisFile));
  } catch {
    // CJS fallback
    return resolveExistingDir(__dirname);
  }
}

/** Shared proto-loader options. */
const PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [protoDir()],
};

/**
 * Load a set of .proto files and return the gRPC package definition.
 */
function loadProtos(filenames: string[]): grpc.GrpcObject {
  const packageDef = protoLoader.loadSync(
    filenames.map((f) => path.join(protoDir(), f)),
    PROTO_LOADER_OPTIONS,
  );
  return grpc.loadPackageDefinition(packageDef);
}

// ---------------------------------------------------------------------------
// Service client types
// ---------------------------------------------------------------------------

/**
 * Minimal type for the generated service client constructor returned by
 * grpc.loadPackageDefinition(). The actual clients extend grpc.Client and
 * expose RPC methods as instance methods.
 */
type ServiceClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: Record<string, unknown>,
) => grpc.Client;

/**
 * A typed wrapper around the dynamically-loaded CommandService client.
 * The RPC methods are added at runtime by grpc-js.
 */
interface CommandServiceClient extends grpc.Client {
  submitAndWaitForTransaction(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, response: any) => void,
  ): void;
  submitAndWait(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, response: any) => void,
  ): void;
}

/**
 * Typed wrapper for the StateService client.
 */
interface StateServiceClient extends grpc.Client {
  getActiveContracts(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<any>;
  getLedgerEnd(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, response: any) => void,
  ): void;
}

/**
 * Typed wrapper for the UpdateService client.
 */
interface UpdateServiceClient extends grpc.Client {
  getUpdates(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<any>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a TemplateId to the Ledger API wire format. */
function toProtoTemplateId(t: TemplateId): Record<string, string> {
  return {
    package_id: t.packageId,
    module_name: t.moduleName,
    entity_name: t.entityName,
  };
}

/** Map a gRPC status code to a structured LedgerError. */
function mapGrpcError(err: grpc.ServiceError): LedgerError {
  const code = err.code ?? grpc.status.UNKNOWN;
  const msg = err.details ?? err.message ?? 'Unknown gRPC error';
  return new LedgerError(
    `Ledger API error (gRPC ${code}): ${msg}`,
    code,
    msg,
    { cause: err },
  );
}

/**
 * Generate a random command ID for ledger submissions.
 * Uses a simple hex string for uniqueness.
 */
function commandId(): string {
  const bytes = new Uint8Array(16);
  // Node >=15 has crypto.getRandomValues on globalThis; fallback to
  // a timestamp + Math.random approach for broader compatibility.
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// GrpcTransport
// ---------------------------------------------------------------------------

/**
 * gRPC-based transport for the Canton Ledger API.
 *
 * Connects to CommandService for create/exercise, StateService for queries,
 * and UpdateService for streaming historical updates.
 *
 * Uses @grpc/proto-loader to dynamically load the Canton Ledger API v2 proto
 * definitions, ensuring all messages are serialized as proper protobuf on the
 * wire rather than JSON.
 *
 * Supports plaintext, TLS, and mTLS channels with optional JWT bearer-token
 * authentication.
 */
export class GrpcTransport implements Transport {
  private readonly commandService: CommandServiceClient;
  private readonly stateService: StateServiceClient;
  private readonly updateService: UpdateServiceClient;
  private readonly log: Logger;
  private readonly config: ClientConfig;
  private closed = false;

  constructor(config: ClientConfig) {
    this.config = config;
    this.log = createLogger('grpc-transport');

    const target = `${config.host}:${config.port}`;

    // --- Channel credentials ---
    let channelCreds: grpc.ChannelCredentials;
    if (config.useTls) {
      channelCreds = config.caCert
        ? grpc.credentials.createSsl(config.caCert)
        : grpc.credentials.createSsl();
    } else {
      channelCreds = grpc.credentials.createInsecure();
    }

    // --- Call credentials (JWT) ---
    // For TLS channels, combine call credentials with the channel credentials.
    // For insecure channels, grpc-js does not allow combineChannelCredentials,
    // so we inject the token via channel options + metadata interceptor instead.
    const channelOptions: Record<string, unknown> = {};
    if (config.token && config.useTls) {
      const callCreds = grpc.credentials.createFromMetadataGenerator(
        (_params, callback) => {
          const md = new grpc.Metadata();
          md.set('authorization', `Bearer ${config.token}`);
          callback(null, md);
        },
      );
      channelCreds = grpc.credentials.combineChannelCredentials(
        channelCreds,
        callCreds,
      );
    } else if (config.token) {
      // Insecure channel: use an interceptor to inject the auth metadata.
      const tokenValue = config.token;
      const authInterceptor = (options: any, nextCall: any) => {
        return new grpc.InterceptingCall(nextCall(options), {
          start(metadata, _listener, next) {
            metadata.set('authorization', `Bearer ${tokenValue}`);
            next(metadata, _listener);
          },
        });
      };
      channelOptions['interceptors'] = [authInterceptor];
    }

    // --- Load proto definitions and create typed service clients ---
    const proto = loadProtos([
      'com/daml/ledger/api/v2/command_service.proto',
      'com/daml/ledger/api/v2/state_service.proto',
      'com/daml/ledger/api/v2/update_service.proto',
    ]);

    // Navigate the package hierarchy:
    // proto.com.daml.ledger.api.v2.CommandService, etc.
    const v2 = (
      (
        ((proto['com'] as grpc.GrpcObject)['daml'] as grpc.GrpcObject)[
          'ledger'
        ] as grpc.GrpcObject
      )['api'] as grpc.GrpcObject
    )['v2'] as grpc.GrpcObject;

    const CommandServiceCtor = v2['CommandService'] as unknown as ServiceClientConstructor;
    const StateServiceCtor = v2['StateService'] as unknown as ServiceClientConstructor;
    const UpdateServiceCtor = v2['UpdateService'] as unknown as ServiceClientConstructor;

    this.commandService = new CommandServiceCtor(
      target,
      channelCreds,
      channelOptions,
    ) as unknown as CommandServiceClient;

    this.stateService = new StateServiceCtor(
      target,
      channelCreds,
      channelOptions,
    ) as unknown as StateServiceClient;

    this.updateService = new UpdateServiceCtor(
      target,
      channelCreds,
      channelOptions,
    ) as unknown as UpdateServiceClient;

    this.log.info({ target, tls: config.useTls }, 'gRPC transport initialized');
  }

  // -----------------------------------------------------------------------
  // Transport interface
  // -----------------------------------------------------------------------

  async create<T>(
    templateId: TemplateId,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
  ): Promise<CreateResult<T>> {
    this.assertOpen();

    const commands: Record<string, unknown> = {
      command_id: commandId(),
      user_id: this.resolveUserId(),
      act_as: actAs,
      read_as: readAs ?? this.config.readAs ?? actAs,
      commands: [
        {
          create: {
            template_id: toProtoTemplateId(templateId),
            create_arguments: this.encodeRecord(argument),
          },
        },
      ],
    };
    if (this.config.synchronizerId) {
      commands.synchronizer_id = this.config.synchronizerId;
    }

    this.log.debug({ templateId, actAs }, 'Submitting create command');

    try {
      const response = await this.submitAndWaitForTransaction(commands, actAs);
      const createdEvent = this.extractCreatedEvent(response);
      return {
        contractId: createdEvent.contract_id,
        result: this.decodeRecord<T>(createdEvent.create_arguments),
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async exercise<T>(
    templateId: TemplateId,
    contractId: string,
    choiceName: string,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
  ): Promise<T> {
    this.assertOpen();

    const commands: Record<string, unknown> = {
      command_id: commandId(),
      user_id: this.resolveUserId(),
      act_as: actAs,
      read_as: readAs ?? this.config.readAs ?? actAs,
      commands: [
        {
          exercise: {
            template_id: toProtoTemplateId(templateId),
            contract_id: contractId,
            choice: choiceName,
            choice_argument: this.encodeValue(argument),
          },
        },
      ],
    };
    if (this.config.synchronizerId) {
      commands.synchronizer_id = this.config.synchronizerId;
    }

    this.log.debug({ templateId, contractId, choiceName, actAs }, 'Submitting exercise command');

    try {
      // Use LEDGER_EFFECTS shape (2) to include ExercisedEvent in response
      const response = await this.submitAndWaitForTransaction(commands, actAs, 2);
      const exerciseResult = this.extractExerciseResult(response);
      return this.decodeValue<T>(exerciseResult);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async exerciseByKey<T>(
    templateId: TemplateId,
    key: unknown,
    choiceName: string,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
  ): Promise<T> {
    this.assertOpen();

    const commands: Record<string, unknown> = {
      command_id: commandId(),
      user_id: this.resolveUserId(),
      act_as: actAs,
      read_as: readAs ?? this.config.readAs ?? actAs,
      commands: [
        {
          exercise_by_key: {
            template_id: toProtoTemplateId(templateId),
            contract_key: this.encodeValue(key),
            choice: choiceName,
            choice_argument: this.encodeValue(argument),
          },
        },
      ],
    };
    if (this.config.synchronizerId) {
      commands.synchronizer_id = this.config.synchronizerId;
    }

    this.log.debug({ templateId, choiceName, actAs }, 'Submitting exerciseByKey command');

    try {
      // Use LEDGER_EFFECTS shape (2) to include ExercisedEvent in response
      const response = await this.submitAndWaitForTransaction(commands, actAs, 2);
      const exerciseResult = this.extractExerciseResult(response);
      return this.decodeValue<T>(exerciseResult);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async query<T>(
    templateId: TemplateId,
    filter: Record<string, unknown> | undefined,
    actAs: string[],
    readAs?: string[],
  ): Promise<T[]> {
    this.assertOpen();

    const parties = [...actAs, ...(readAs ?? this.config.readAs ?? actAs)];
    const uniqueParties = [...new Set(parties)];

    // Build a CumulativeFilter with template_filter for each party.
    const partyFilters = {
      cumulative: [
        {
          template_filter: {
            template_id: toProtoTemplateId(templateId),
          },
        },
      ],
    };

    // Canton 3.4.11+ requires active_at_offset — fetch current ledger end first.
    const offset = await this.getLedgerEnd();

    const request = {
      active_at_offset: parseInt(offset, 10),
      event_format: {
        filters_by_party: Object.fromEntries(
          uniqueParties.map((party) => [party, partyFilters]),
        ),
        verbose: true,
      },
    };

    this.log.debug({ templateId, parties: uniqueParties, offset }, 'Querying active contracts');

    try {
      const contracts = await this.getActiveContracts(request);
      this.log.debug({ contractCount: contracts.length }, 'ACS query returned contracts');
      return contracts
        .map((c: any) => {
          const decoded = this.decodeRecord<T>(c.create_arguments);
          // Attach contract_id from the created_event to the decoded payload
          const contractId = c.contract_id ?? c.contractId;
          if (contractId) {
            (decoded as any).contractId = contractId;
          }
          if (c.offset !== undefined && c.offset !== null) {
            (decoded as any)._offset = String(c.offset);
          }
          // Preserve template identity from the created_event so callers
          // can determine which template this contract came from without
          // relying on field-shape detection.
          const templateId = c.template_id ?? c.templateId;
          if (templateId) {
            (decoded as any)._templateId = {
              packageId: templateId.package_id ?? templateId.packageId ?? '',
              moduleName: templateId.module_name ?? templateId.moduleName ?? '',
              entityName: templateId.entity_name ?? templateId.entityName ?? '',
            };
          }
          return decoded;
        })
        .filter((payload: T) => {
          if (!filter) return true;
          return Object.entries(filter).every(
            ([k, v]) => (payload as any)[k] === v,
          );
        });
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /**
   * Stream historical and live updates from the ledger.
   *
   * @param templateId  - Daml template identifier.
   * @param beginOffset - Exclusive begin offset (empty string for ledger begin).
   * @param endOffset   - Inclusive end offset (omit for unbounded / live tail).
   * @param actAs       - Parties to act as.
   * @param readAs      - Additional read-as parties (optional).
   * @param onUpdate    - Callback invoked for each update response.
   * @param onError     - Callback invoked on stream error.
   * @param onEnd       - Callback invoked when the stream ends.
   * @returns A cancel function to abort the stream.
   */
  getUpdates(
    templateId: TemplateId,
    beginOffset: string,
    endOffset: string | undefined,
    actAs: string[],
    readAs: string[] | undefined,
    onUpdate: (update: any) => void,
    onError: (err: Error) => void,
    onEnd: () => void,
  ): () => void {
    this.assertOpen();

    const parties = [...actAs, ...(readAs ?? this.config.readAs ?? actAs)];
    const uniqueParties = [...new Set(parties)];

    // Build event_format with template filter for each party
    const partyFilters = {
      cumulative: [
        { template_filter: { template_id: toProtoTemplateId(templateId) } },
      ],
    };

    const eventFormat = {
      filters_by_party: Object.fromEntries(
        uniqueParties.map((party) => [party, partyFilters]),
      ),
      verbose: true,
    };

    const request: Record<string, unknown> = {
      begin_exclusive: beginOffset ? parseInt(beginOffset, 10) : 0,
      update_format: {
        include_transactions: {
          event_format: eventFormat,
          transaction_shape: 2, // LEDGER_EFFECTS: include exercised events for history reconstruction
        },
      },
    };

    if (endOffset !== undefined) {
      request['end_inclusive'] = parseInt(endOffset, 10);
    }

    const metadata = this.buildMetadata();
    const stream = this.updateService.getUpdates(request, metadata);

    stream.on('data', (chunk: any) => {
      onUpdate(chunk);
    });
    stream.on('error', (err: grpc.ServiceError) => {
      onError(mapGrpcError(err));
    });
    stream.on('end', () => {
      onEnd();
    });

    return () => {
      stream.cancel();
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.commandService.close();
    this.stateService.close();
    this.updateService.close();
    this.log.info('gRPC transport closed');
  }

  // -----------------------------------------------------------------------
  // Internal: command submission
  // -----------------------------------------------------------------------

  /**
   * Build a default EventFormat for the acting parties.
   * Uses a wildcard filter so we see all events from the transaction.
   */
  private buildEventFormat(actAs: string[]): Record<string, unknown> {
    const wildcardFilters = { cumulative: [{ wildcard_filter: {} }] };
    return {
      filters_by_party: Object.fromEntries(
        actAs.map((party) => [party, wildcardFilters]),
      ),
      verbose: true,
    };
  }

  /**
   * Submit commands via CommandService.SubmitAndWaitForTransaction.
   *
   * In Canton 3.4.11+, SubmitAndWaitForTransactionRequest has:
   *   { commands, transaction_format: { event_format, transaction_shape } }
   *
   * transaction_shape controls the response events layout.
   */
  private submitAndWaitForTransaction(
    commandsPayload: Record<string, unknown>,
    actAs: string[],
    transactionShape: number = 1,
  ): Promise<any> {
    const request = {
      commands: commandsPayload,
      transaction_format: {
        event_format: this.buildEventFormat(actAs),
        transaction_shape: transactionShape, // 1=ACS_DELTA (create), 2=LEDGER_EFFECTS (exercise)
      },
    };
    return new Promise((resolve, reject) => {
      const metadata = this.buildMetadata();
      this.commandService.submitAndWaitForTransaction(
        request,
        metadata,
        (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else resolve(response);
        },
      );
    });
  }

  /**
   * Fetch the current ledger end offset from StateService.GetLedgerEnd.
   * Canton 3.4.11+ requires active_at_offset in GetActiveContracts requests.
   */
  private getLedgerEnd(): Promise<string> {
    return new Promise((resolve, reject) => {
      const metadata = this.buildMetadata();
      this.stateService.getLedgerEnd({}, metadata, (err, response) => {
        if (err) return reject(err);
        const offset = response?.offset;
        if (offset === undefined || offset === null) {
          return reject(new Error('getLedgerEnd returned no offset'));
        }
        resolve(String(offset));
      });
    });
  }

  /**
   * Fetch active contracts via StateService.GetActiveContracts.
   * Collects all streamed responses into a single array of CreatedEvents.
   */
  private getActiveContracts(request: Record<string, unknown>): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const metadata = this.buildMetadata();
      const stream = this.stateService.getActiveContracts(request, metadata);

      const results: any[] = [];
      stream.on('data', (chunk: any) => {
        // In Canton 3.4.11+, active_contract is an ActiveContract message
        // containing { created_event, synchronizer_id, reassignment_counter }.
        if (chunk.active_contract?.created_event) {
          results.push(chunk.active_contract.created_event);
        }
      });
      stream.on('error', (err: grpc.ServiceError) => reject(err));
      stream.on('end', () => resolve(results));
    });
  }

  // -----------------------------------------------------------------------
  // Internal: encoding / decoding
  // -----------------------------------------------------------------------

  /**
   * Encode a JS object into the Ledger API Record value format.
   * Maps each key/value pair into a RecordField.
   */
  private encodeRecord(obj: Record<string, unknown>): Record<string, unknown> {
    return {
      fields: Object.entries(obj).map(([label, value]) => ({
        label,
        value: this.encodeValue(value),
      })),
    };
  }

  /**
   * Encode a single JS value into a Ledger API Value.
   *
   * The command layer can pre-tag values with their Ledger API type by
   * passing an object with a single recognized key. This ensures Daml
   * types are encoded correctly on the wire:
   *
   *   { party: "alice" }                          → Value.party
   *   { numeric: "1000.00" }                      → Value.numeric
   *   { timestamp: "1640000000000000" }            → Value.timestamp (μs)
   *   { int64: "86400000000" }                     → Value.int64
   *   { bool: true }                               → Value.bool
   *   { text: "hello" }                            → Value.text
   *   { contract_id: "..." } / { contractId: "..." } → Value.contract_id
   *   { variant: { variant_constructor, value } }  → Value.variant
   *   { list: { elements: [...] } }                → Value.list
   *   { text_map: { entries: [{ key, value }] } }  → Value.text_map
   *   { gen_map: { entries: [{ key, value }] } }   → Value.gen_map
   *   { record: { fields: [...] } }                → Value.record
   *   { tag: "Foo", value: {...} }                 → Variant shorthand
   *
   * For untagged values, the encoder infers the type from the JS type:
   *   string → text, number → int64, boolean → bool, Date → timestamp,
   *   array → list, object → record, null/undefined → unit.
   */
  private encodeValue(val: unknown): Record<string, unknown> {
    if (val === null || val === undefined) return { unit: {} };

    // --- Pre-tagged Ledger API Values ---
    if (typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj);

      // Single-key pre-tagged value wrappers
      if (keys.length === 1) {
        const key = keys[0];
        switch (key) {
          case 'party':
            return { party: obj.party };
          case 'numeric':
            return { numeric: String(obj.numeric) };
          case 'timestamp':
            return { timestamp: String(obj.timestamp) };
          case 'int64':
            return { int64: String(obj.int64) };
          case 'bool':
            return { bool: obj.bool };
          case 'text':
            return { text: obj.text };
          case 'contract_id':
            return { contract_id: obj.contract_id };
          case 'contractId':
            return { contract_id: obj.contractId };
          case 'unit':
            return { unit: {} };
          default:
            // Not a recognized tag — fall through to other checks
            break;
        }
      }

      // Pre-tagged optional
      if ('optional' in obj && keys.length === 1) {
        return {
          optional: obj.optional != null
            ? { value: this.encodeValue(obj.optional) }
            : {},
        };
      }

      // Pre-tagged enum (full form: { enum: { enum_constructor: "Foo" } })
      if ('enum' in obj && keys.length === 1) {
        return { enum: obj.enum };
      }

      // Pre-tagged variant (full form)
      if ('variant' in obj && keys.length === 1) {
        const v = obj.variant as Record<string, unknown>;
        return {
          variant: {
            variant_constructor: v.variant_constructor,
            value: this.encodeValue(v.value),
          },
        };
      }

      // Pre-tagged list (full form: { list: { elements: [...] } })
      if ('list' in obj && keys.length === 1) {
        const lst = obj.list as Record<string, unknown>;
        const elements = (lst.elements as unknown[]) ?? [];
        return {
          list: { elements: elements.map((e) => this.encodeValue(e)) },
        };
      }

      // Pre-tagged TextMap (full form: { text_map: { entries: [{ key, value }] } })
      if ('text_map' in obj && keys.length === 1) {
        const map = obj.text_map as Record<string, unknown>;
        const entries = (map.entries as any[]) ?? [];
        return {
          text_map: {
            entries: entries.map((entry) => ({
              key: entry.key,
              value: this.encodeValue(entry.value),
            })),
          },
        };
      }

      // Pre-tagged GenMap (full form: { gen_map: { entries: [{ key, value }] } })
      if ('gen_map' in obj && keys.length === 1) {
        const map = obj.gen_map as Record<string, unknown>;
        const entries = (map.entries as any[]) ?? [];
        return {
          gen_map: {
            entries: entries.map((entry) => ({
              key: this.encodeValue(entry.key),
              value: this.encodeValue(entry.value),
            })),
          },
        };
      }

      // Pre-tagged record (full form: { record: { fields: [...] } })
      if ('record' in obj && keys.length === 1) {
        const rec = obj.record as Record<string, unknown>;
        const fields = (rec.fields as any[]) ?? [];
        return {
          record: {
            fields: fields.map((f: any) => ({
              label: f.label,
              value: this.encodeValue(f.value),
            })),
          },
        };
      }

      // Variant shorthand: { tag: "Foo", value: {...} }
      if ('tag' in obj && 'value' in obj && keys.length === 2) {
        const inner = obj.value;
        return {
          variant: {
            variant_constructor: obj.tag,
            value: (inner && typeof inner === 'object' && !Array.isArray(inner)
              && Object.keys(inner as any).length > 0)
              ? { record: this.encodeRecord(inner as Record<string, unknown>) }
              : { unit: {} },
          },
        };
      }

      // Fallback: treat as a record
      return { record: this.encodeRecord(obj) };
    }

    // --- Untagged JS values (type inference) ---
    if (typeof val === 'string') return { text: val };
    if (typeof val === 'number') return { int64: val.toString() };
    if (typeof val === 'boolean') return { bool: val };
    if (val instanceof Date) {
      // Encode as microseconds since epoch (Daml Time)
      const micros = BigInt(val.getTime()) * 1000n;
      return { timestamp: micros.toString() };
    }
    if (Array.isArray(val)) {
      return { list: { elements: val.map((v) => this.encodeValue(v)) } };
    }
    return { text: String(val) };
  }

  /** Decode a Ledger API Record into a plain JS object. */
  private decodeRecord<T>(record: any): T {
    if (!record?.fields) return {} as T;
    const result: Record<string, unknown> = {};
    for (const field of record.fields) {
      result[field.label] = this.decodeValue(field.value);
    }
    return result as T;
  }

  /** Decode a single Ledger API Value into a JS value. */
  private decodeValue<T>(val: any): T {
    if (!val) return undefined as unknown as T;
    if ('text' in val) return val.text as T;
    if ('int64' in val) return val.int64 as T;
    if ('numeric' in val) return val.numeric as T;
    if ('bool' in val) return val.bool as T;
    if ('timestamp' in val) return val.timestamp as T;
    if ('party' in val) return val.party as T;
    if ('contract_id' in val) return val.contract_id as T;
    if ('contractId' in val) return val.contractId as T;
    if ('unit' in val) return undefined as unknown as T;
    if ('record' in val) return this.decodeRecord<T>(val.record);
    if ('variant' in val) {
      return {
        tag: val.variant.variant_constructor ?? val.variant.constructor,
        value: this.decodeValue(val.variant.value),
      } as T;
    }
    if ('list' in val) {
      return (val.list.elements ?? []).map((e: any) =>
        this.decodeValue(e),
      ) as T;
    }
    if ('optional' in val) {
      return val.optional.value
        ? this.decodeValue<T>(val.optional.value)
        : (undefined as unknown as T);
    }
    if ('text_map' in val) {
      const entries = val.text_map.entries ?? [];
      const obj: Record<string, unknown> = {};
      for (const entry of entries) {
        obj[entry.key] = this.decodeValue(entry.value);
      }
      return obj as T;
    }
    if ('gen_map' in val) {
      const entries = val.gen_map.entries ?? [];
      const obj: Record<string, unknown> = {};
      for (const entry of entries) {
        obj[String(this.decodeValue(entry.key))] = this.decodeValue(entry.value);
      }
      return obj as T;
    }
    if ('enum' in val) {
      return (val.enum.enum_constructor ?? val.enum.constructor) as T;
    }
    return val as T;
  }

  // -----------------------------------------------------------------------
  // Internal: helpers
  // -----------------------------------------------------------------------

  /** Build gRPC call metadata (currently empty; JWT is on the channel). */
  private buildMetadata(): grpc.Metadata {
    return new grpc.Metadata();
  }

  /**
   * Resolve the Canton user_id for command submissions.
   * Falls back to the first actAs party's display name (before ::).
   */
  private resolveUserId(): string {
    if (this.config.userId) return this.config.userId;
    const first: string | undefined = this.config.actAs[0];
    if (first !== undefined) {
      const parts = first.split('::');
      return parts[0] ?? 'default-user';
    }
    return 'default-user';
  }

  /** Extract the first CreatedEvent from a SubmitAndWaitForTransaction response. */
  private extractCreatedEvent(response: any): any {
    const events =
      response?.transaction?.events ??
      response?.transaction_tree?.events_by_id;
    if (!events) {
      throw new LedgerError('No events in transaction response');
    }
    // Flat transaction: array of events
    if (Array.isArray(events)) {
      const created = events.find((e: any) => e.created);
      if (!created) throw new LedgerError('No CreatedEvent in transaction');
      return created.created;
    }
    // Transaction tree: map of event IDs
    for (const ev of Object.values(events) as any[]) {
      if (ev.created) return ev.created;
    }
    throw new LedgerError('No CreatedEvent in transaction tree');
  }

  /** Extract the exercise result from a SubmitAndWaitForTransactionTree response. */
  private extractExerciseResult(response: any): any {
    const events =
      response?.transaction_tree?.events_by_id ??
      response?.transaction?.events;
    if (!events) {
      throw new LedgerError('No events in exercise response');
    }
    if (Array.isArray(events)) {
      const exercised = events.find((e: any) => e.exercised);
      if (!exercised)
        throw new LedgerError('No ExercisedEvent in transaction');
      return exercised.exercised.exercise_result;
    }
    for (const ev of Object.values(events) as any[]) {
      if (ev.exercised) return ev.exercised.exercise_result;
    }
    throw new LedgerError('No ExercisedEvent in transaction tree');
  }

  /** Ensure the transport has not been closed. */
  private assertOpen(): void {
    if (this.closed) {
      throw new TransportError('Transport has been closed');
    }
  }

  /** Wrap an unknown error into the SDK error hierarchy. */
  private wrapError(err: unknown): Error {
    if (err instanceof LedgerError || err instanceof TransportError) return err;
    if (err && typeof err === 'object' && 'code' in err) {
      return mapGrpcError(err as grpc.ServiceError);
    }
    return new TransportError(
      `Unexpected transport error: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
