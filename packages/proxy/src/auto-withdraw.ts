import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import {
  AmuletWalletGatewayAdapter,
  AssetType,
  CantonStreamsClient,
  SettlementMode,
  StreamStatus,
  TransferOfferAdapter,
  TransferRuleAdapter,
  VestingMode,
  createSigningFromEnv,
  getBalances,
  type ClientConfig,
  type GatewayPrepareExecuteParams,
  type SettlementOrchestrator,
  type SigningProviderResolver,
  type Stream,
  type Transport,
  type VestingModeConfig,
  type InstrumentRef,
  type LedgerRecord,
} from '@canton-streams/sdk';
import {
  createHostWalletClient,
  parseHostWalletAdapterKind,
  type HostWalletAdapterKind,
  type HostWalletClient,
  type PendingTransferRecord,
  type WalletSigningCredentials,
} from './host-wallet.js';

export interface AutoWithdrawConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly interactiveEnabled: boolean;
  readonly recipientAutoAcceptEnabled: boolean;
  readonly hostWalletAdapter: HostWalletAdapterKind;
  readonly recipientPendingPollAttempts: number;
  readonly recipientPendingPollIntervalMs: number;
  readonly discoveryParties: readonly string[];
  readonly jsonApiUrl?: string;
  readonly jsonApiToken?: string;
  readonly serviceUserId?: string;
  readonly synchronizerId?: string;
  /**
   * When true (PROXY_AUTO_WITHDRAW_SUBSCRIBER_MODE=true), the worker
   * uses the event-driven `TransferEventsSubscriber` instead
   * of the poll-based cycle loop. The subscriber reacts to
   * `Allocation_Settle` events from TransferEventsV2 or the raw Ledger
   * API fallback. This reduces latency from poll-interval to event receipt
   * and removes the busy poll loop.
   */
  readonly subscriberMode: boolean;
  /**
   * When true (`PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER=true`), the
   * worker routes the interactive submission through
   * `SigningProvider.prepareExecuteAndWait()` instead of doing
   * an in-process `prepare → node:crypto.sign → execute` trio.
   *
   * Signing keys live in the Wallet Gateway's bound signing provider
   * (Participant / Fireblocks / Blockdaemon / Dfns / wallet-gateway-internal),
   * never in the proxy process.
   *
   * Requires `CANTON_STREAMS_WALLET_GATEWAY_URL` +
   * `CANTON_STREAMS_WALLET_GATEWAY_TOKEN` in env.
   */
  readonly useSigningProvider: boolean;
}

export interface AutoWithdrawCandidate {
  readonly sender: string;
  readonly streamId: string;
  readonly withdrawable: string;
}

export interface AutoWithdrawCycleResult {
  readonly scanned: number;
  readonly eligible: number;
  readonly executed: number;
  readonly failed: number;
}

export interface DiscoveredTokenStandardStream extends Stream {
  readonly templateId: string;
}

interface DiscoveredContractEvent {
  readonly contractId: string;
  readonly templateId: string;
  readonly createArguments: Record<string, unknown>;
}

interface InteractivePreparedTransaction {
  readonly preparedTransactionHash?: string;
  readonly preparedTransaction?: string;
  readonly hashingSchemeVersion?: string;
  readonly deduplicationPeriod?: unknown;
}

interface InteractiveWithdrawCandidate {
  readonly stream: DiscoveredTokenStandardStream;
  readonly withdrawable: Decimal;
  readonly withdrawTime: Date;
}

function createDefaultAdapters() {
  return [
    new AmuletWalletGatewayAdapter(),
    new TransferOfferAdapter(),
    new TransferRuleAdapter(),
  ] as const;
}

export function parseAutoWithdrawConfig(
  env: Record<string, string | undefined>,
): AutoWithdrawConfig {
  const enabled = parseBoolean(env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_ENABLED']);
  const pollIntervalMs = parsePositiveInt(
    env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_POLL_INTERVAL_MS'],
    10_000,
  );
  const interactiveEnabled = parseBoolean(
    env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_INTERACTIVE_ENABLED'],
  );
  const recipientAutoAcceptEnabled = parseBoolean(
    env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_RECIPIENT_AUTOACCEPT_ENABLED'],
  );

  return {
    enabled,
    pollIntervalMs,
    interactiveEnabled,
    recipientAutoAcceptEnabled,
    hostWalletAdapter: parseHostWalletAdapterKind(
      env['PROXY_TOKEN_STANDARD_HOST_WALLET_ADAPTER'] ??
      env['CANTON_STREAMS_HOST_WALLET_ADAPTER'],
    ),
    recipientPendingPollAttempts: parsePositiveInt(
      env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_RECIPIENT_PENDING_POLL_ATTEMPTS'],
      24,
    ),
    recipientPendingPollIntervalMs: parsePositiveInt(
      env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_RECIPIENT_PENDING_POLL_INTERVAL_MS'],
      2_500,
    ),
    discoveryParties: parsePartyList(
      env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_DISCOVERY_PARTIES'],
    ),
    jsonApiUrl: trimToUndefined(
      env['CANTON_JSON_API_URL'] ?? env['PROXY_CANTON_JSON_API_URL'],
    ),
    // Keep JSON-API auth on ledger-read credentials only; do not fall
    // back to service-tier proxy credentials.
    jsonApiToken: trimToUndefined(
      env['PROXY_TOKEN_STANDARD_AUTOWITHDRAW_JSON_API_TOKEN'] ??
      env['CANTON_TOKEN'] ??
      env['LEDGER_TOKEN'],
    ),
    serviceUserId: trimToUndefined(
      env['PROXY_SERVICE_USER_ID'] ??
      env['SERVICE_USER_ID'] ??
      env['CANTON_USER_ID'],
    ),
    synchronizerId: trimToUndefined(
      env['CANTON_SYNCHRONIZER_ID'] ?? env['SYNCHRONIZER_ID'],
    ),
    subscriberMode: parseBoolean(
      env['PROXY_AUTO_WITHDRAW_SUBSCRIBER_MODE'],
    ),
    useSigningProvider: parseBoolean(
      env['PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER'],
    ),
  };
}

export function findEligibleTokenStandardStreams(
  streams: readonly Stream[],
  escrowOperator: string,
  now: Date = new Date(),
): AutoWithdrawCandidate[] {
  return streams
    .filter((stream) =>
      stream.config.settlementMode === SettlementMode.TokenStandardCustody &&
      stream.state.status === StreamStatus.Active &&
      stream.escrowRef?.escrowOperator === escrowOperator,
    )
    .map((stream) => {
      const balances = getBalances(stream, now);
      return {
        sender: stream.config.sender,
        streamId: stream.config.streamId,
        withdrawable: balances.withdrawable.toFixed(10),
        // Keep the Decimal alongside the string so the filter below can
        // do real numeric comparison without re-parsing.
        withdrawableDecimal: balances.withdrawable,
      };
    })
    // [H9 fix] Previously this was `stream.withdrawable !== '0.0000000000'`,
    // which admitted any sub-cent value (e.g. '0.0000000001') and triggered
    // meaningless on-ledger withdraws that either fail at the Daml `ensure`
    // ("amount must be positive" is true but accrual not yet meaningful) or
    // waste a tx + ledger fees.
    //
    // MIN_WITHDRAW_THRESHOLD is configurable via env (default: 0.01); set
    // appropriate to the asset's smallest meaningful unit.
    .filter((stream) => stream.withdrawableDecimal.greaterThan(MIN_WITHDRAW_THRESHOLD))
    // Drop the helper field before returning so callers see the original shape.
    .map(({ withdrawableDecimal: _, ...rest }) => rest);
}

const MIN_WITHDRAW_THRESHOLD = new Decimal(
  process.env['PROXY_MIN_WITHDRAW_THRESHOLD'] ?? '0.01',
);

export function extractDiscoveredTokenStandardStreams(
  payload: unknown,
): DiscoveredTokenStandardStream[] {
  return extractCreatedEvents(payload)
    .filter((event) => isTokenStandardEscrowTemplateId(event.templateId))
    .map((event) =>
      deserializeTokenStandardEscrow(
        event.contractId,
        event.templateId,
        event.createArguments,
      ),
    );
}

export async function discoverTokenStandardStreamsViaJsonApi(
  config: Pick<
    AutoWithdrawConfig,
    'jsonApiUrl' | 'jsonApiToken' | 'serviceUserId' | 'discoveryParties'
  >,
): Promise<DiscoveredTokenStandardStream[]> {
  const baseUrl = requireValue(config.jsonApiUrl, 'CANTON_JSON_API_URL');
  const serviceUserId = requireValue(config.serviceUserId, 'PROXY_SERVICE_USER_ID');

  if (config.discoveryParties.length === 0) {
    return [];
  }

  const ledgerEnd = await requestJson<{ offset?: number | string }>(
    `${baseUrl.replace(/\/+$/, '')}/v2/state/ledger-end`,
    config.jsonApiToken,
    {
      method: 'GET',
    },
  );

  const offsetValue = ledgerEnd.offset;
  if (offsetValue === undefined || offsetValue === null) {
    throw new Error(
      `JSON API /v2/state/ledger-end did not return offset: ${JSON.stringify(ledgerEnd)}`,
    );
  }

  const payload = await requestJson<unknown>(
    `${baseUrl.replace(/\/+$/, '')}/v2/state/active-contracts`,
    config.jsonApiToken,
    {
      method: 'POST',
      body: {
        userId: serviceUserId,
        activeAtOffset: Number(offsetValue),
        filter: {
          filtersByParty: Object.fromEntries(
            config.discoveryParties.map((party) => [
              party,
              {
                cumulative: [
                  {
                    identifierFilter: {
                      WildcardFilter: {
                        value: {
                          includeCreatedEventBlob: false,
                        },
                      },
                    },
                  },
                ],
              },
            ]),
          ),
        },
      },
    },
  );

  return extractDiscoveredTokenStandardStreams(payload);
}

export async function runTokenStandardAutoWithdrawCycle(
  clientConfig: ClientConfig,
  orchestrator: SettlementOrchestrator,
  escrowOperator: string,
  logger: any,
  autoWithdrawConfig: AutoWithdrawConfig = {
    enabled: false,
    pollIntervalMs: 10_000,
    interactiveEnabled: false,
    recipientAutoAcceptEnabled: false,
    hostWalletAdapter: 'wallet-gateway-transfer-accept',
    recipientPendingPollAttempts: 24,
    recipientPendingPollIntervalMs: 2_500,
    discoveryParties: [],
    subscriberMode: false,
    useSigningProvider: false,
  },
  now: Date = new Date(),
): Promise<AutoWithdrawCycleResult> {
  if (autoWithdrawConfig.interactiveEnabled) {
    return runInteractiveTokenStandardAutoWithdrawCycle(
      clientConfig,
      escrowOperator,
      logger,
      autoWithdrawConfig,
      now,
    );
  }

  return runLegacyTokenStandardAutoWithdrawCycle(
    clientConfig,
    orchestrator,
    escrowOperator,
    logger,
    now,
  );
}

/**
 * Start the auto-withdraw worker. When `config.subscriberMode` is true,
 * the worker delegates to the
 * event-driven `TransferEventsSubscriber` and skips the poll loop;
 * the supplied `runCycle` callback is used only as a manual-trigger
 * backstop (e.g. via the admin endpoint).
 *
 * In subscriber mode the caller is responsible for wiring the
 * subscriber's event handlers to the corresponding stream-advancing
 * exercises — see `startSubscriberAutoWithdrawWorker` for the wired
 * variant.
 */
export function startTokenStandardAutoWithdrawWorker(
  config: AutoWithdrawConfig,
  runCycle: () => Promise<AutoWithdrawCycleResult>,
  logger: any,
): () => void {
  if (!config.enabled) {
    return () => undefined;
  }

  if (config.subscriberMode) {
    logger.info(
      'PROXY_AUTO_WITHDRAW_SUBSCRIBER_MODE=true — poll loop suppressed; ' +
      'use startSubscriberAutoWithdrawWorker to wire the event-driven path. ' +
      'Manual trigger via admin endpoint remains available.',
    );
    // Return a no-op disposer; the subscriber is started externally.
    return () => undefined;
  }

  let running = true;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    if (!running) {
      return;
    }

    try {
      const result = await runCycle();
      if (result.executed > 0 || result.failed > 0) {
        logger.info(
          { autoWithdraw: result },
          'Token-standard auto-withdraw cycle completed',
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'Token-standard auto-withdraw cycle crashed');
    } finally {
      if (running) {
        timer = setTimeout(loop, config.pollIntervalMs);
      }
    }
  };

  timer = setTimeout(loop, config.pollIntervalMs);

  return () => {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function runLegacyTokenStandardAutoWithdrawCycle(
  clientConfig: ClientConfig,
  orchestrator: SettlementOrchestrator,
  escrowOperator: string,
  logger: any,
  now: Date,
): Promise<AutoWithdrawCycleResult> {
  const client = new CantonStreamsClient(clientConfig);

  try {
    const streams = await client.listStreams({
      settlementMode: SettlementMode.TokenStandardCustody,
      status: StreamStatus.Active,
    });
    const eligible = findEligibleTokenStandardStreams(streams, escrowOperator, now);

    let executed = 0;
    let failed = 0;

    for (const candidate of eligible) {
      try {
        await orchestrator.withdraw(
          client._transport,
          candidate.sender,
          candidate.streamId,
          [escrowOperator],
          logger,
        );
        executed += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          {
            sender: candidate.sender,
            streamId: candidate.streamId,
            err: error,
          },
          'Token-standard auto-withdraw attempt failed',
        );
      }
    }

    return {
      scanned: streams.length,
      eligible: eligible.length,
      executed,
      failed,
    };
  } finally {
    await client.close();
  }
}

async function runInteractiveTokenStandardAutoWithdrawCycle(
  clientConfig: ClientConfig,
  escrowOperator: string,
  logger: any,
  autoWithdrawConfig: AutoWithdrawConfig,
  now: Date,
): Promise<AutoWithdrawCycleResult> {
  const client = new CantonStreamsClient(clientConfig);

  try {
    const streams = await discoverTokenStandardStreamsViaJsonApi({
      jsonApiUrl: autoWithdrawConfig.jsonApiUrl,
      jsonApiToken: autoWithdrawConfig.jsonApiToken ?? clientConfig.token,
      serviceUserId: autoWithdrawConfig.serviceUserId ?? clientConfig.userId,
      discoveryParties: autoWithdrawConfig.discoveryParties,
    });
    const eligible = findInteractiveWithdrawCandidates(streams, escrowOperator, now);

    let executed = 0;
    let failed = 0;

    for (const candidate of eligible) {
      try {
        await executeInteractiveWithdraw(
          client._transport,
          candidate.stream,
          candidate.withdrawable,
          escrowOperator,
          autoWithdrawConfig,
          candidate.withdrawTime,
        );
        executed += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          {
            sender: candidate.stream.config.sender,
            streamId: candidate.stream.config.streamId,
            contractId: candidate.stream.contractId,
            err: error,
          },
          'Token-standard interactive auto-withdraw attempt failed',
        );
      }
    }

    return {
      scanned: streams.length,
      eligible: eligible.length,
      executed,
      failed,
    };
  } finally {
    await client.close();
  }
}

function findInteractiveWithdrawCandidates(
  streams: readonly DiscoveredTokenStandardStream[],
  escrowOperator: string,
  now: Date,
): InteractiveWithdrawCandidate[] {
  return streams
    .filter((stream) =>
      stream.config.settlementMode === SettlementMode.TokenStandardCustody &&
      stream.state.status === StreamStatus.Active &&
      stream.escrowRef?.escrowOperator === escrowOperator,
    )
    .map((stream) => ({
      stream,
      withdrawable: getBalances(stream, now).withdrawable,
      withdrawTime: now,
    }))
    .filter((candidate) => candidate.withdrawable.greaterThan(0));
}

export async function executeInteractiveWithdraw(
  transport: Transport,
  stream: DiscoveredTokenStandardStream,
  withdrawable: Decimal,
  escrowOperator: string,
  autoWithdrawConfig: AutoWithdrawConfig,
  withdrawTime: Date = new Date(),
): Promise<void> {
  const jsonApiUrl = requireValue(autoWithdrawConfig.jsonApiUrl, 'CANTON_JSON_API_URL');
  const jsonApiToken = requireValue(
    autoWithdrawConfig.jsonApiToken,
    'PROXY_SERVICE_TOKEN',
  );
  const serviceUserId = requireValue(
    autoWithdrawConfig.serviceUserId,
    'PROXY_SERVICE_USER_ID',
  );

  const instrumentRef = stream.config.instrumentRef ?? stream.escrowRef?.instrumentRef;
  if (!instrumentRef?.issuer || !instrumentRef.instrumentId) {
    throw new Error(
      `Stream ${stream.config.streamId} is missing instrumentRef; cannot auto-withdraw.`,
    );
  }

  const adapter = await selectAdapter(
    instrumentRef.issuer,
    instrumentRef.instrumentId,
  );
  const walletGatewayBaseUrl = trimToUndefined(
    process.env['CANTON_STREAMS_WALLET_GATEWAY_URL'] ??
    process.env['WALLET_GATEWAY_URL'],
  )?.replace(/\/+$/, '');
  const recipientHostWalletClient =
    autoWithdrawConfig.recipientAutoAcceptEnabled
      ? createHostWalletClient({
          baseUrl: walletGatewayBaseUrl,
          adapter: autoWithdrawConfig.hostWalletAdapter,
          resolveCredentials: resolveSigningCredentials,
          signPreparedHash,
        })
      : null;
  let pendingTransfer: PendingTransferRecord | null = null;
  let settledAmount = withdrawable;
  let effectiveWithdrawTime = withdrawTime;

  if (recipientHostWalletClient) {
    pendingTransfer = await findRecoverableRecipientPendingTransfer(
      recipientHostWalletClient,
      stream.config.recipient,
      {
        sender: escrowOperator,
        receiver: stream.config.recipient,
        maxAmount: withdrawable,
      },
    );
    if (pendingTransfer?.amount) {
      settledAmount = pendingTransfer.amount;
      effectiveWithdrawTime = resolveWithdrawTimeForRecoveredAmount(
        stream,
        settledAmount,
        withdrawTime,
      );
    }
  }

  const pendingTransferExpectation = {
    sender: escrowOperator,
    receiver: stream.config.recipient,
    amount: settledAmount,
  };
  const settlementReference = buildInteractiveSettlementReference(
    stream.config.streamId,
    effectiveWithdrawTime,
  );
  const commandId =
    `streams-autowithdraw-${stream.config.streamId}-${effectiveWithdrawTime.getTime()}`;

  // Prepare the ledger withdraw first using the exact amount/time pair that the
  // choice will validate on-ledger. This prevents us from locking funds in an
  // external transfer instruction when the ledger rejects the withdraw request.
  const prepared = await requestJson<InteractivePreparedTransaction>(
    `${jsonApiUrl.replace(/\/+$/, '')}/v2/interactive-submission/prepare`,
    jsonApiToken,
    {
      method: 'POST',
      body: {
        userId: serviceUserId,
        commandId,
        commands: [
          {
            ExerciseCommand: {
              templateId: stream.templateId,
              contractId: stream.contractId,
              choice: 'Withdraw_TokenStandard',
              choiceArgument: {
                withdrawTime: effectiveWithdrawTime.toISOString(),
                settlementReference,
                settledAmount: settledAmount.toFixed(10),
              },
            },
          },
        ],
        actAs: [escrowOperator],
        readAs: [],
        ...(autoWithdrawConfig.synchronizerId
          ? { synchronizerId: autoWithdrawConfig.synchronizerId }
          : {}),
        disclosedContracts: [],
        verboseHashing: false,
        packageIdSelectionPreference: [],
      },
    },
  );

  if (!pendingTransfer) {
    const recipientPendingSnapshot =
      recipientHostWalletClient
        ? await snapshotPendingTransfers(recipientHostWalletClient, stream.config.recipient)
        : new Set<string>();

    const transferResult = await adapter.transfer(
      {
        from: escrowOperator,
        to: stream.config.recipient,
        amount: settledAmount,
        registrar: instrumentRef.issuer,
        instrumentId: instrumentRef.instrumentId,
        reference: settlementReference,
      },
      [escrowOperator],
      transport,
      silentLogger as any,
    );

    if (recipientHostWalletClient && transferResult.receiverAccepted !== true) {
      pendingTransfer = await waitForRecipientPendingTransfer(
        recipientHostWalletClient,
        stream.config.recipient,
        recipientPendingSnapshot,
        pendingTransferExpectation,
        autoWithdrawConfig,
      );
    }
  }

  if (recipientHostWalletClient && pendingTransfer) {
    await recipientHostWalletClient.claimPendingTransfer(
      stream.config.recipient,
      pendingTransfer.contractId,
    );
  }

  // SigningProvider-routed path. The gateway holds the key for
  // `escrowOperator`; we never touch private material here.
  //
  // The earlier in-process `prepare` call already validated the choice
  // args against on-ledger state, so by the time we reach this branch
  // the gateway-side prepare-and-execute should succeed (modulo races
  // with concurrent writers, which we surface as-is).
  if (autoWithdrawConfig.useSigningProvider) {
    await submitWithdrawViaSigningProvider({
      escrowOperator,
      commandId,
      stream,
      effectiveWithdrawTime,
      settlementReference,
      settledAmount,
      synchronizerId: autoWithdrawConfig.synchronizerId,
    });
    return;
  }

  warnInProcessSigningOnce();

  const credentials = resolveSigningCredentials(escrowOperator);

  const preparedTransactionHash = trimToUndefined(prepared.preparedTransactionHash);
  const preparedTransaction = trimToUndefined(prepared.preparedTransaction);
  if (!preparedTransactionHash || !preparedTransaction) {
    throw new Error(
      `Interactive prepare response missing hash/transaction: ${JSON.stringify(prepared)}`,
    );
  }

  const signature = signPreparedHash(preparedTransactionHash, credentials);
  const executeBody = {
    userId: serviceUserId,
    preparedTransaction,
    hashingSchemeVersion:
      trimToUndefined(prepared.hashingSchemeVersion) ?? 'HASHING_SCHEME_VERSION_V2',
    submissionId: commandId,
    deduplicationPeriod:
      prepared.deduplicationPeriod && typeof prepared.deduplicationPeriod === 'object'
        ? prepared.deduplicationPeriod
        : { Empty: {} },
    partySignatures: {
      signatures: [
        {
          party: escrowOperator,
          signatures: [
            {
              signature,
              signedBy: fingerprintFromParty(escrowOperator),
              format: 'SIGNATURE_FORMAT_CONCAT',
              signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519',
            },
          ],
        },
      ],
    },
  };

  // Atomicity gap: at this point the off-chain transfer
  // (adapter.transfer above) has already moved funds. If executeAndWait
  // fails permanently, the ledger has no record of the withdraw. The
  // `commandId` / `submissionId` (line 617) is Canton's idempotency key —
  // retrying with the same id is safe (Canton dedups), so transient
  // failures can be retried without re-submitting the off-chain
  // transfer.
  //
  // Strategy: bounded retry on transient errors (network, 5xx). On
  // permanent failure, surface a STRUCTURED error log so ops can
  // reconcile the off-chain transfer manually. We do NOT auto-rollback
  // the transfer (compensating transfer is non-trivial without
  // persistent state and creates risk of double-undo).
  //
  // The long-term fix is the AllocationRequest pattern, where
  // the transfer + ledger record happen in one atomic transaction.
  const EXECUTE_RETRY_LIMIT = 3;
  let executeAttempt = 0;
  let executeError: unknown;
  while (executeAttempt < EXECUTE_RETRY_LIMIT) {
    executeAttempt++;
    try {
      await requestJson(
        `${jsonApiUrl.replace(/\/+$/, '')}/v2/interactive-submission/executeAndWait`,
        jsonApiToken,
        { method: 'POST', body: executeBody },
      );
      executeError = undefined;
      break;
    } catch (error) {
      executeError = error;
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      const shouldFallback =
        message.includes('404') ||
        message.includes('405') ||
        message.includes('method not allowed') ||
        message.includes('unsupported endpoint') ||
        message.includes('not found');
      if (shouldFallback) {
        // Endpoint-mismatch fallback path; retry against /execute instead of /executeAndWait.
        try {
          await requestJson(
            `${jsonApiUrl.replace(/\/+$/, '')}/v2/interactive-submission/execute`,
            jsonApiToken,
            { method: 'POST', body: executeBody },
          );
          executeError = undefined;
          break;
        } catch (fallbackErr) {
          executeError = fallbackErr;
        }
      }
      // Transient retry — exponential backoff with jitter.
      const isTransient =
        message.includes('5') ||           // 5xx
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('socket hang up');
      if (!isTransient || executeAttempt >= EXECUTE_RETRY_LIMIT) break;
      const delayMs = 250 * Math.pow(2, executeAttempt - 1) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (executeError !== undefined) {
    // Structured error for ops monitoring. Off-chain transfer
    // already executed (settlementReference is the dedup key); operator
    // must reconcile manually or invoke the admin retry endpoint.
    console.error(
      JSON.stringify({
        event: 'autowithdraw.execute_failed_after_transfer',
        severity: 'critical',
        riskRef: 'off_chain_transfer_after_ledger_execute_failure',
        streamId: stream.config.streamId,
        commandId,
        settlementReference,
        settledAmount: settledAmount.toFixed(10),
        attempts: executeAttempt,
        error: String(executeError instanceof Error ? executeError.message : executeError),
        remediation: 'Off-chain transfer moved funds; ledger has no record. ' +
          'Either re-run executeAndWait with the same commandId (Canton dedups), ' +
          'or manually issue a Withdraw_TokenStandard exercise with matching settlementReference.',
      }),
    );
    throw executeError;
  }
}

function buildInteractiveSettlementReference(
  streamId: string,
  withdrawTime: Date,
): string {
  return `withdraw-${streamId}-${withdrawTime.getTime()}`;
}

function resolveWithdrawTimeForRecoveredAmount(
  stream: DiscoveredTokenStandardStream,
  settledAmount: Decimal,
  latestAllowedTime: Date,
): Date {
  const latestBalances = getBalances(stream, latestAllowedTime);
  if (latestBalances.withdrawable.equals(settledAmount)) {
    return latestAllowedTime;
  }

  const lowerBound = (
    stream.state.lastWithdrawTime ??
    stream.config.startTime
  ).getTime();
  const upperBound = Math.min(
    latestAllowedTime.getTime(),
    stream.config.endTime.getTime(),
  );

  let low = lowerBound;
  let high = upperBound;
  let candidate: number | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const amount = getBalances(stream, new Date(mid)).withdrawable;
    if (amount.lessThan(settledAmount)) {
      low = mid + 1;
    } else {
      candidate = mid;
      high = mid - 1;
    }
  }

  if (candidate === null) {
    throw new Error(
      `Unable to recover withdrawTime for ${stream.config.streamId}: ` +
      `no time produced ${settledAmount.toFixed(10)} withdrawable.`,
    );
  }

  const matchedTime = findExactWithdrawTime(
    stream,
    settledAmount,
    candidate,
    upperBound,
  );
  if (matchedTime === null) {
    throw new Error(
      `Unable to recover exact withdrawTime for ${stream.config.streamId} ` +
      `and amount ${settledAmount.toFixed(10)}.`,
    );
  }

  return new Date(matchedTime);
}

/**
 * [H8 fix] Find the exact ms timestamp at which the stream's withdrawable
 * equals `settledAmount`.
 *
 * Previously this was a 1ms-step linear scan from `fromMs` to `toMs`. On
 * realistic large ranges (binary search lands within minutes; range = 60_000+
 * ms) this loops 60k+ iterations of `getBalances()` per call — at scale it
 * was DoS-class.
 *
 * Replaced with the algebraic inverse of `linearAccrual`:
 *
 *   accrued(t) = total * (t - start) / (end - start)
 *
 * Solving for t when accrued = settledAmount + totalWithdrawn:
 *
 *   t = start + (settledAmount + totalWithdrawn) / total * (end - start)
 *
 * We verify the result with one `getBalances` call to guard against
 * non-linear vesting modes (cliff, stepped). For non-linear modes we
 * fall back to a shorter bounded scan (max 1000 iterations) to keep
 * latency bounded.
 */
function findExactWithdrawTime(
  stream: DiscoveredTokenStandardStream,
  settledAmount: Decimal,
  fromMs: number,
  toMs: number,
): number | null {
  const config = stream.config;
  const startMs = config.startTime.getTime();
  const endMs = config.endTime.getTime();
  const total = new Decimal(config.totalDeposited);
  const withdrawn = new Decimal(stream.state.totalWithdrawn ?? 0);

  // Try the Linear algebraic inverse first.
  // VestingModeConfig discriminator field is `mode`, not `kind`.
  if (config.vestingMode?.mode === 'Linear' || config.vestingMode === undefined) {
    const targetAccrued = settledAmount.plus(withdrawn);
    if (total.greaterThan(0)) {
      const ratio = targetAccrued.div(total);
      const tMs = Math.round(startMs + ratio.toNumber() * (endMs - startMs));
      // Clamp into supplied range; verify exactness.
      const candidateMs = Math.max(fromMs, Math.min(toMs, tMs));
      const actual = getBalances(stream, new Date(candidateMs)).withdrawable;
      if (actual.equals(settledAmount)) return candidateMs;
      // Allow ±1ms tolerance for Decimal rounding.
      for (const delta of [-1, 1, -2, 2]) {
        const tryMs = candidateMs + delta;
        if (tryMs < fromMs || tryMs > toMs) continue;
        if (getBalances(stream, new Date(tryMs)).withdrawable.equals(settledAmount)) {
          return tryMs;
        }
      }
    }
  }

  // Non-Linear modes: bounded scan as fallback. Cap iterations to
  // prevent DoS — if we can't find within 1000 ms, the caller can
  // widen the search via another binary-search pass.
  const MAX_SCAN_ITERATIONS = 1000;
  const scanEnd = Math.min(toMs, fromMs + MAX_SCAN_ITERATIONS);
  for (let timeMs = fromMs; timeMs <= scanEnd; timeMs += 1) {
    if (getBalances(stream, new Date(timeMs)).withdrawable.equals(settledAmount)) {
      return timeMs;
    }
  }
  return null;
}

async function snapshotPendingTransfers(
  hostWalletClient: HostWalletClient,
  party: string,
): Promise<Set<string>> {
  const rows = await hostWalletClient.listPendingTransfers(party);
  return new Set(rows.map((row) => row.contractId));
}

async function waitForRecipientPendingTransfer(
  hostWalletClient: HostWalletClient,
  party: string,
  excludedContractIds: ReadonlySet<string>,
  expected: {
    readonly sender: string;
    readonly receiver: string;
    readonly amount: Decimal;
  },
  config: Pick<
    AutoWithdrawConfig,
    'recipientPendingPollAttempts' | 'recipientPendingPollIntervalMs'
  >,
): Promise<PendingTransferRecord> {
  for (let attempt = 1; attempt <= config.recipientPendingPollAttempts; attempt += 1) {
    const rows = await hostWalletClient.listPendingTransfers(party);
    const match = findMatchingPendingTransfer(rows, excludedContractIds, expected);
    if (match) {
      return match;
    }

    if (attempt < config.recipientPendingPollAttempts) {
      await sleep(config.recipientPendingPollIntervalMs);
    }
  }

  throw new Error(
    `Recipient pending transfer did not appear for ${party.split('::')[0]} ` +
    `after ${config.recipientPendingPollAttempts} attempts.`,
  );
}

async function findRecoverableRecipientPendingTransfer(
  hostWalletClient: HostWalletClient,
  party: string,
  expected: {
    readonly sender: string;
    readonly receiver: string;
    readonly maxAmount: Decimal;
  },
): Promise<PendingTransferRecord | null> {
  const rows = await hostWalletClient.listPendingTransfers(party);
  return findRecoverablePendingTransfer(rows, expected);
}

async function selectAdapter(registrar: string, instrumentId: string) {
  for (const adapter of createDefaultAdapters()) {
    if (await adapter.canHandle(registrar, instrumentId)) {
      return adapter;
    }
  }

  throw new Error(
    `No settlement adapter available for registrar=${registrar.split('::')[0]}, instrumentId=${instrumentId}.`,
  );
}

function deserializeTokenStandardEscrow(
  contractId: string,
  templateId: string,
  raw: Record<string, unknown>,
): DiscoveredTokenStandardStream {
  const rawConfig = asRecord(raw['config']);
  const rawState = asRecord(raw['state']);
  const instrumentRef =
    deserializeInstrumentRef(rawConfig['instrumentRef']) ??
    deserializeInstrumentRef(raw['instrumentRef']) ?? {
      depository: '',
      issuer: '',
      instrumentId: '',
      instrumentVersion: '',
    };

  return {
    contractId,
    templateId,
    config: {
      streamId: asText(rawConfig['streamId']),
      sender: asText(rawConfig['sender']),
      recipient: asText(rawConfig['recipient']),
      totalDeposited: new Decimal(asText(rawConfig['totalDeposited']) || '0'),
      startTime: deserializeTime(rawConfig['startTime']),
      endTime: deserializeTime(rawConfig['endTime']),
      vestingMode: deserializeVestingMode(rawConfig['vestingMode']),
      assetType: deserializeAssetType(rawConfig['assetType']),
      instrumentRef: instrumentRef.issuer ? instrumentRef : undefined,
      cancellable: asBoolean(rawConfig['cancellable'], true),
      settlementMode: SettlementMode.TokenStandardCustody,
    },
    state: {
      totalWithdrawn: new Decimal(asText(rawState['totalWithdrawn']) || '0'),
      status: deserializeStatus(rawState['status']),
      lastWithdrawTime: rawState['lastWithdrawTime']
        ? deserializeTime(rawState['lastWithdrawTime'])
        : undefined,
      renewalCount: asNumber(rawState['renewalCount'], 0),
    },
    escrowRef: {
      escrowHoldingCid: asText(raw['escrowReference']),
      escrowAmount: asText(raw['escrowAmount']) || '0',
      escrowOperator: asText(raw['escrowOperator']),
      instrumentRef,
      recipientAccount: deserializeLedgerRecordFromText(raw['recipientAccountRef']) ?? {},
      fundingReference: asText(raw['fundingReference']) || undefined,
      lastSettlementReference: deserializeOptionalText(raw['lastSettlementReference']),
      senderAccountRef: asText(raw['senderAccountRef']) || undefined,
      recipientAccountRef: asText(raw['recipientAccountRef']) || undefined,
    },
  };
}

function extractCreatedEvents(payload: unknown): DiscoveredContractEvent[] {
  const rawEntries = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)['activeContracts'])
      ? (asRecord(payload)['activeContracts'] as unknown[])
      : Array.isArray(asRecord(payload)['result'])
        ? (asRecord(payload)['result'] as unknown[])
        : [];

  return rawEntries
    .map((entry) => {
      const record = asRecord(entry);
      const contractEntry = asRecord(record['contractEntry']);
      const jsActiveContract = asRecord(contractEntry['JsActiveContract']);
      const createdEvent =
        maybeRecord(jsActiveContract['createdEvent']) ??
        maybeRecord(record['createdEvent']) ??
        maybeRecord(contractEntry['createdEvent']);

      if (!createdEvent) {
        return null;
      }

      return {
        contractId: asText(createdEvent['contractId']) || asText(createdEvent['contract_id']),
        templateId: normalizeTemplateId(
          createdEvent['templateId'] ?? createdEvent['template_id'],
        ),
        createArguments:
          maybeRecord(createdEvent['createArguments']) ??
          maybeRecord(createdEvent['createArgument']) ??
          maybeRecord(createdEvent['create_arguments']) ??
          {},
      };
    })
    .filter((event): event is DiscoveredContractEvent => Boolean(event?.contractId && event.templateId));
}

function normalizeTemplateId(value: unknown): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }

  const record = asRecord(value);
  const packageId = asText(record['packageId']) || asText(record['package_id']) || asText(record['package']);
  const moduleName = asText(record['moduleName']) || asText(record['module_name']) || asText(record['module']);
  const entityName = asText(record['entityName']) || asText(record['entity_name']) || asText(record['entity']);
  return [packageId, moduleName, entityName].filter(Boolean).join(':');
}

function isTokenStandardEscrowTemplateId(templateId: string): boolean {
  return templateId.replace(/^#/, '').endsWith(
    ':CantonStreams.Stream.TokenStandardEscrow:TokenStandardEscrow',
  );
}

async function requestJson<T>(
  url: string,
  token: string | undefined,
  init: {
    readonly method: 'GET' | 'POST';
    readonly body?: Record<string, unknown>;
  },
): Promise<T> {
  const response = await fetch(url, {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const rendered =
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`HTTP ${response.status} ${url}: ${rendered}`);
  }

  return (payload ?? {}) as T;
}

function findMatchingPendingTransfer(
  rows: readonly PendingTransferRecord[],
  excludedContractIds: ReadonlySet<string>,
  expected: {
    readonly sender: string;
    readonly receiver: string;
    readonly amount: Decimal;
  },
): PendingTransferRecord | null {
  const matches = rows
    .filter((row) =>
      !excludedContractIds.has(row.contractId) &&
      !row.expired &&
      row.sender === expected.sender &&
      row.receiver === expected.receiver &&
      row.amount?.equals(expected.amount),
    )
    .sort(comparePendingTransferPriority);

  return matches[0] ?? null;
}

function findRecoverablePendingTransfer(
  rows: readonly PendingTransferRecord[],
  expected: {
    readonly sender: string;
    readonly receiver: string;
    readonly maxAmount: Decimal;
  },
): PendingTransferRecord | null {
  const exactMatch = findMatchingPendingTransfer(rows, new Set<string>(), {
    sender: expected.sender,
    receiver: expected.receiver,
    amount: expected.maxAmount,
  });
  if (exactMatch) {
    return exactMatch;
  }

  const matches = rows
    .filter((row) =>
      !row.expired &&
      row.sender === expected.sender &&
      row.receiver === expected.receiver &&
      row.amount?.greaterThan(0) &&
      row.amount?.lessThanOrEqualTo(expected.maxAmount),
    )
    .sort(comparePendingTransferPriority);

  return matches[0] ?? null;
}

function comparePendingTransferPriority(
  left: PendingTransferRecord,
  right: PendingTransferRecord,
): number {
  const amountOrder = (right.amount?.cmp(left.amount ?? 0) ?? 0);
  if (amountOrder !== 0) {
    return amountOrder;
  }

  const requestedAtOrder =
    (right.requestedAt?.getTime() ?? 0) - (left.requestedAt?.getTime() ?? 0);
  if (requestedAtOrder !== 0) {
    return requestedAtOrder;
  }

  return right.contractId.localeCompare(left.contractId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSigningCredentials(party: string): WalletSigningCredentials {
  const credentials = readWalletSigningCredentialsFromEnv()[party];
  if (!credentials) {
    throw new Error(
      `No interactive signing credentials configured for ${party}. ` +
      'Provide CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON or PROXY_ESCROW_OPERATOR_* env vars.',
    );
  }
  return credentials;
}

function readWalletSigningCredentialsFromEnv(): Record<string, WalletSigningCredentials> {
  const credentials: Record<string, WalletSigningCredentials> = {};
  const rawMapping = trimToUndefined(
    process.env['CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON'],
  );

  if (rawMapping) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON: ${message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'CANTON_STREAMS_WALLET_GATEWAY_CREDENTIALS_JSON must be a JSON object keyed by party ID.',
      );
    }

    for (const [party, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeSigningCredentials(value);
      if (normalized) {
        credentials[party] = normalized;
      }
    }
  }

  injectLegacySigningCredentials(
    credentials,
    process.env['PROXY_ESCROW_OPERATOR'] ?? process.env['ESCROW_OPERATOR'],
    {
      appToken:
        process.env['PROXY_ESCROW_OPERATOR_APP_TOKEN'] ??
        process.env['ESCROW_OPERATOR_APP_TOKEN'],
      publicKey:
        process.env['PROXY_ESCROW_OPERATOR_PUBLIC_KEY'] ??
        process.env['ESCROW_OPERATOR_PUBLIC_KEY'],
      privateKey:
        process.env['PROXY_ESCROW_OPERATOR_PRIVATE_KEY'] ??
        process.env['ESCROW_OPERATOR_PRIVATE_KEY'],
      privateKeyFile:
        process.env['PROXY_ESCROW_OPERATOR_PRIVATE_KEY_FILE'] ??
        process.env['ESCROW_OPERATOR_PRIVATE_KEY_FILE'],
    },
  );

  return credentials;
}

function injectLegacySigningCredentials(
  target: Record<string, WalletSigningCredentials>,
  party: string | undefined,
  value: Partial<WalletSigningCredentials>,
): void {
  const partyId = trimToUndefined(party);
  if (!partyId || target[partyId]) {
    return;
  }

  const normalized = normalizeSigningCredentials(value);
  if (normalized) {
    target[partyId] = normalized;
  }
}

function normalizeSigningCredentials(
  value: unknown,
): WalletSigningCredentials | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const publicKey = trimToUndefined(
    asText(record['publicKey']) ?? asText(record['public_key']),
  );
  const privateKey = trimToUndefined(
    asText(record['privateKey']) ?? asText(record['private_key']),
  );
  const privateKeyFile = trimToUndefined(
    asText(record['privateKeyFile']) ?? asText(record['private_key_file']),
  );

  if (!publicKey || (!privateKey && !privateKeyFile)) {
    return undefined;
  }

  const appToken = trimToUndefined(
    asText(record['appToken']) ?? asText(record['token']),
  );

  return {
    ...(appToken ? { appToken } : {}),
    publicKey,
    ...(privateKey ? { privateKey } : {}),
    ...(privateKeyFile ? { privateKeyFile } : {}),
  };
}

// ---------------------------------------------------------------------------
// SigningProvider-routed submission (replaces in-process signing).
// ---------------------------------------------------------------------------

interface SigningProviderWithdrawArgs {
  readonly escrowOperator: string;
  readonly commandId: string;
  readonly stream: DiscoveredTokenStandardStream;
  readonly effectiveWithdrawTime: Date;
  readonly settlementReference: string;
  readonly settledAmount: Decimal;
  readonly synchronizerId?: string | undefined;
}

let cachedSigningResolver: SigningProviderResolver | null = null;

async function getOrInitSigningResolver(): Promise<SigningProviderResolver> {
  if (cachedSigningResolver) {
    return cachedSigningResolver;
  }
  const { resolver } = await createSigningFromEnv();
  cachedSigningResolver = resolver;
  return resolver;
}

/**
 * Test-only: clear the cached resolver between vitest runs.
 *
 * @internal
 */
export function __resetSigningResolverForTests(): void {
  cachedSigningResolver = null;
  warnedInProcess = false;
}

async function submitWithdrawViaSigningProvider(
  args: SigningProviderWithdrawArgs,
): Promise<void> {
  const resolver = await getOrInitSigningResolver();
  const provider = await resolver.forParty(args.escrowOperator);
  const params: GatewayPrepareExecuteParams = {
    commandId: args.commandId,
    commands: [
      {
        ExerciseCommand: {
          templateId: args.stream.templateId,
          contractId: args.stream.contractId,
          choice: 'Withdraw_TokenStandard',
          choiceArgument: {
            withdrawTime: args.effectiveWithdrawTime.toISOString(),
            settlementReference: args.settlementReference,
            settledAmount: args.settledAmount.toFixed(10),
          },
        },
      },
    ],
    actAs: [args.escrowOperator],
    readAs: [],
    disclosedContracts: [],
    packageIdSelectionPreference: [],
    ...(args.synchronizerId ? { synchronizerId: args.synchronizerId } : {}),
  };

  await provider.prepareExecuteAndWait(params);
}

let warnedInProcess = false;

function warnInProcessSigningOnce(): void {
  if (warnedInProcess) {
    return;
  }
  warnedInProcess = true;
   
  console.warn(
    '[canton-streams/proxy] In-process signing path is deprecated. ' +
    'Set PROXY_AUTO_WITHDRAW_USE_SIGNING_PROVIDER=true plus ' +
    'CANTON_STREAMS_WALLET_GATEWAY_URL + CANTON_STREAMS_WALLET_GATEWAY_TOKEN ' +
    'to route signing through the Wallet Gateway.',
  );
}

function signPreparedHash(
  preparedTransactionHash: string,
  credentials: WalletSigningCredentials,
): string {
  const hashBytes = Buffer.from(preparedTransactionHash, 'base64');

  if (credentials.privateKeyFile) {
    const pem = readFileSync(credentials.privateKeyFile, 'utf8');
    return cryptoSign(null, hashBytes, createPrivateKey(pem)).toString('base64');
  }

  const privateKey = trimToUndefined(credentials.privateKey);
  if (!privateKey) {
    throw new Error('interactive signing credentials are missing a private key');
  }

  // Use prefix match, not substring. Previously
  // `includes('BEGIN')` would treat any string containing "BEGIN" anywhere
  // as PEM-encoded, which could misclassify a base64 secret that happens
  // to contain those letters. PEM is always anchored at `-----BEGIN`.
  if (privateKey.startsWith('-----BEGIN')) {
    return cryptoSign(null, hashBytes, createPrivateKey(privateKey)).toString('base64');
  }

  const naclSecret = Buffer.from(privateKey, 'base64');
  if (naclSecret.length !== 64) {
    throw new Error(
      `interactive privateKey must decode to 64 bytes (NaCl seed+pub), got ${naclSecret.length}`,
    );
  }

  const seed = naclSecret.subarray(0, 32);
  const pkcs8Header = Buffer.from([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22,
    0x04, 0x20,
  ]);
  const signingKey = createPrivateKey({
    key: Buffer.concat([pkcs8Header, seed]),
    format: 'der',
    type: 'pkcs8',
  });

  return cryptoSign(null, hashBytes, signingKey).toString('base64');
}

function fingerprintFromParty(party: string): string {
  const pieces = String(party).split('::');
  return pieces[pieces.length - 1] ?? '';
}

function deserializeTime(raw: unknown): Date {
  if (raw instanceof Date) {
    return raw;
  }
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) {
      return new Date(Number(BigInt(raw) / 1000n));
    }
    return new Date(raw);
  }
  if (typeof raw === 'number') {
    return new Date(raw);
  }

  const record = asRecord(raw);
  if (record && record['seconds'] !== undefined) {
    const secondsRaw = record['seconds'];
    const seconds =
      typeof secondsRaw === 'string' ? BigInt(secondsRaw) : BigInt(asNumber(secondsRaw, 0));
    const nanos = asNumber(record['nanos'], 0);
    return new Date(Number(seconds * 1000n) + Math.floor(nanos / 1_000_000));
  }

  return new Date(String(raw ?? ''));
}

function deserializeVestingMode(raw: unknown): VestingModeConfig {
  if (!raw) {
    return { mode: VestingMode.Linear };
  }

  const record = asRecord(raw);
  const tag = asText(record['tag']) || asText(record['variant_constructor']) || asText(raw);
  const value = asRecord(record['value']);

  switch (tag) {
    case 'CliffLinear':
      return {
        mode: VestingMode.CliffLinear,
        cliffTime: deserializeTime(value['cliffTime']),
      };
    case 'Stepped':
      return {
        mode: VestingMode.Stepped,
        stepInterval: asNumber(value['stepInterval'], 0),
        amountPerStep: new Decimal(asText(value['amountPerStep']) || '0'),
      };
    case 'RenewableTerm':
      return {
        mode: VestingMode.RenewableTerm,
        termDuration: asNumber(value['termDuration'], 0),
      };
    case 'Linear':
    default:
      return { mode: VestingMode.Linear };
  }
}

function deserializeAssetType(raw: unknown): AssetType {
  const record = asRecord(raw);
  const tag = asText(record['tag']) || asText(record['variant_constructor']) || asText(raw);

  switch (tag) {
    case 'ValidatorLocalAsset':
    case 'LocalToken':
      return AssetType.ValidatorLocalAsset;
    case 'LocalCip56':
    case 'LocalHolding':
      return AssetType.LocalCip56;
    case 'GlobalHolding':
    case 'GlobalCip56':
    default:
      return AssetType.GlobalCip56;
  }
}

function deserializeInstrumentRef(raw: unknown): InstrumentRef | undefined {
  if (!raw) {
    return undefined;
  }

  const record = asRecord(raw);
  const tag = asText(record['tag']) || asText(record['variant_constructor']);
  if (tag === 'None') {
    return undefined;
  }

  const value = tag === 'Some' ? asRecord(record['value']) : record;
  const depository = asText(value['depository']);
  if (!depository) {
    return undefined;
  }

  return {
    depository,
    issuer: asText(value['issuer']),
    instrumentId: asText(value['instrumentId']),
    instrumentVersion: asText(value['instrumentVersion']),
  };
}

function deserializeLedgerRecordFromText(raw: unknown): LedgerRecord | undefined {
  const text = asText(asRecord(raw)['text']) || asText(raw);
  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LedgerRecord;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function deserializeOptionalText(raw: unknown): string | undefined {
  if (!raw) {
    return undefined;
  }

  const record = asRecord(raw);
  const tag = asText(record['tag']) || asText(record['variant_constructor']);
  if (tag === 'None') {
    return undefined;
  }
  if (tag === 'Some') {
    return asText(asRecord(record['value'])['text']) || asText(record['value']) || undefined;
  }

  return asText(record['text']) || asText(raw) || undefined;
}

function deserializeStatus(raw: unknown): StreamStatus {
  const rendered = asText(raw);
  switch (rendered) {
    case StreamStatus.Completed:
      return StreamStatus.Completed;
    case StreamStatus.Cancelled:
      return StreamStatus.Cancelled;
    case StreamStatus.Active:
    default:
      return StreamStatus.Active;
  }
}

function parseBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePartyList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((party) => party.trim())
    .filter(Boolean);
}

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : undefined;
}

function requireValue(value: string | undefined, envName: string): string {
  const rendered = trimToUndefined(value);
  if (!rendered) {
    throw new Error(`Missing required auto-withdraw configuration: ${envName}`);
  }
  return rendered;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseInt(asText(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const silentLogger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
};

// ---------------------------------------------------------------------------
// Subscriber-mode worker — event-driven settlement advancement
// ---------------------------------------------------------------------------

import {
  createSubscriber,
  type SubscriberAsset,
  type SettlementEvent,
  type TransferEventsSubscriber,
} from './transfer-events-subscriber.js';

/**
 * Wire a subscriber-mode auto-withdraw worker. Returns a disposer that
 * cleanly stops the subscription.
 *
 * The supplied `onSettlement` handler is called for each detected
 * `Allocation_Settle` event; the caller exercises the corresponding
 * stream-state-advancing choice (`Withdraw_Stream`, `Withdraw_Flow`,
 * `ConfirmMilestone`) based on the affected escrow contract.
 *
 * Manual-trigger paths (e.g. the admin HTTP endpoint) remain available
 * and continue to call `runCycle` directly.
 *
 */
export function startSubscriberAutoWithdrawWorker(args: {
  readonly config: AutoWithdrawConfig;
  readonly ledgerApiUrl: string;
  readonly ledgerApiToken?: string;
  readonly assets: ReadonlyArray<SubscriberAsset>;
  readonly packageHashes: ReadonlyArray<string>;
  readonly subscribeAs: ReadonlyArray<string>;
  readonly logger: any;
  readonly onSettlement: (event: SettlementEvent) => Promise<void>;
}): { readonly stop: () => Promise<void>; readonly subscriber: TransferEventsSubscriber } {
  if (!args.config.enabled || !args.config.subscriberMode) {
    return {
      stop: async () => undefined,
      subscriber: createSubscriber({
        ledgerApiUrl: args.ledgerApiUrl,
        assets: [],
        packageHashes: [],
        subscribeAs: [],
        logger: args.logger ?? silentLogger,
      }),
    };
  }

  const subscriber = createSubscriber({
    ledgerApiUrl: args.ledgerApiUrl,
    ledgerApiToken: args.ledgerApiToken,
    assets: args.assets,
    packageHashes: args.packageHashes,
    subscribeAs: args.subscribeAs,
    logger: args.logger ?? silentLogger,
  });

  subscriber.on('settlement:completed', async (event: SettlementEvent) => {
    try {
      await args.onSettlement(event);
      args.logger.info?.(
        { assetKey: event.assetKey, allocationCid: event.allocationCid, updateId: event.updateId },
        'Stream state advanced in response to Allocation_Settle event',
      );
    } catch (err) {
      args.logger.error?.(
        { err, event },
        'Stream-advance handler failed; subscriber will retry on next event',
      );
      subscriber.emit('settlement:failed', { event, error: err });
    }
  });

  subscriber.start().catch((err: unknown) => {
    args.logger.error?.({ err }, 'TransferEventsSubscriber failed to start');
  });

  return {
    subscriber,
    stop: async () => {
      await subscriber.stop();
    },
  };
}
