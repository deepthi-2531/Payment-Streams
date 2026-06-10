/**
 * @module transport/base
 *
 * Abstract transport interface for communicating with the Canton Ledger API.
 * Implementations handle the wire protocol (gRPC, HTTP JSON, etc.).
 */

/**
 * Result of a successful create (command submission that produces a contract).
 */
export interface CreateResult<T> {
  /** Ledger contract ID of the newly created contract. */
  readonly contractId: string;
  /** Decoded create argument / payload as returned by the ledger. */
  readonly result: T;
}

/**
 * Identifier for a Daml template on the ledger.
 */
export interface TemplateId {
  /** Daml package name or package ID hash. */
  readonly packageId: string;
  /** Fully qualified module name (e.g. "CantonStreams.Stream"). */
  readonly moduleName: string;
  /** Entity (template) name. */
  readonly entityName: string;
}

/**
 * An explicitly disclosed contract attached to a command submission.
 *
 * Registry token-standard APIs (e.g. Amulet's choice-context endpoints)
 * return contracts the submitter is not a stakeholder of (AmuletRules,
 * OpenMiningRound, …) that must be disclosed for the choice to execute.
 *
 * `templateId` accepts the structured form or the `"pkg:Module:Entity"`
 * string that registry APIs return verbatim.
 */
export interface DisclosedContract {
  readonly templateId: TemplateId | string;
  readonly contractId: string;
  /** Base64-encoded created-event blob, as returned by the registry API. */
  readonly createdEventBlob: string;
  /** Synchronizer the contract lives on (required by some participants). */
  readonly synchronizerId?: string;
}

/**
 * Optional per-command options for create/exercise submissions.
 */
export interface CommandOptions {
  /** Contracts to disclose alongside the command. */
  readonly disclosedContracts?: ReadonlyArray<DisclosedContract>;
}

/**
 * Parse a `TemplateId | string` into the structured form. The string
 * form is `"packageRef:Module.Name:Entity"` — module names may contain
 * dots, so split on the first and last colon.
 */
export function parseTemplateId(t: TemplateId | string): TemplateId {
  if (typeof t !== 'string') return t;
  const first = t.indexOf(':');
  const last = t.lastIndexOf(':');
  if (first === -1 || last === first) {
    throw new Error(`Invalid template id string: "${t}" (expected "pkg:Module:Entity")`);
  }
  return {
    packageId: t.slice(0, first),
    moduleName: t.slice(first + 1, last),
    entityName: t.slice(last + 1),
  };
}

/**
 * Transport abstraction over the Canton Ledger API.
 *
 * All methods accept explicit `actAs` / `readAs` parties so a single
 * transport instance can be shared across callers with different party sets.
 */
export interface Transport {
  /**
   * Submit a create command for the given template.
   *
   * @param templateId - Daml template identifier.
   * @param argument   - Create argument payload (JSON-API shape).
   * @param actAs      - Parties to act as for this command.
   * @param readAs     - Additional read-as parties (optional).
   * @returns The contract ID and decoded result.
   */
  create<T>(
    templateId: TemplateId,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
    opts?: CommandOptions,
  ): Promise<CreateResult<T>>;

  /**
   * Exercise a choice on a contract identified by its contract ID.
   *
   * @param templateId  - Daml template identifier.
   * @param contractId  - Contract ID to exercise on.
   * @param choiceName  - Name of the Daml choice.
   * @param argument    - Choice argument payload.
   * @param actAs       - Parties to act as.
   * @param readAs      - Additional read-as parties (optional).
   * @returns The exercise result, decoded to type T.
   */
  exercise<T>(
    templateId: TemplateId,
    contractId: string,
    choiceName: string,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
    opts?: CommandOptions,
  ): Promise<T>;

  /**
   * Exercise a choice on a contract identified by its contract key.
   *
   * @param templateId  - Daml template identifier.
   * @param key         - Contract key value.
   * @param choiceName  - Name of the Daml choice.
   * @param argument    - Choice argument payload.
   * @param actAs       - Parties to act as.
   * @param readAs      - Additional read-as parties (optional).
   * @returns The exercise result, decoded to type T.
   */
  exerciseByKey<T>(
    templateId: TemplateId,
    key: unknown,
    choiceName: string,
    argument: Record<string, unknown>,
    actAs: string[],
    readAs?: string[],
    opts?: CommandOptions,
  ): Promise<T>;

  /**
   * Query active contracts for a given template, optionally filtered.
   *
   * @param templateId - Daml template identifier.
   * @param filter     - Optional key/value filter on the contract payload.
   * @param actAs      - Parties to act as.
   * @param readAs     - Additional read-as parties (optional).
   * @returns Array of matching contract payloads.
   */
  query<T>(
    templateId: TemplateId,
    filter: Record<string, unknown> | undefined,
    actAs: string[],
    readAs?: string[],
  ): Promise<T[]>;

  /**
   * Gracefully close the underlying connection / channel.
   * After calling close(), the transport must not be reused.
   */
  close(): Promise<void>;
}
