/**
 * TanStack Query hooks for stream data.
 *
 * Uses the REST proxy API client (fetch-based, browser-safe) instead of
 * the Node gRPC SDK directly.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateStreamParams,
  RenewParams,
  StreamFilter,
  PendingStreamRequestFilter,
} from '@canton-streams/sdk/browser';
import type {
  V1CreateStreamParams,
  V1SettleParams,
  StreamInstrument,
} from '../api/client.js';
import { useCantonClient } from './useCantonClient.js';
import { useAuth } from '../store/auth.js';
import { isHostedLedgerAvailable } from '../lib/hostedWalletLedger.js';
import {
  settleV1ViaWallet,
  fundReceiverClaimV1ViaWallet,
  claimV1ViaWallet,
  acceptTransferV1ViaWallet,
  withdrawTransferV1ViaWallet,
} from '../lib/settleV1Wallet.js';
import { listReceivedViaWallet, acceptReceivedViaWallet } from '../lib/receivedV1Wallet.js';

/**
 * Delay in ms before refetching after a mutation.
 *
 * Canton's ACS (Active Contract Set) takes a moment to reflect exercised
 * choices because the old contract is archived and a new one is created.
 * Immediate refetch often returns stale data, so we add a short delay
 * then refetch twice to be sure we get the updated state.
 */
const POST_MUTATION_DELAY = 1_500;
const POST_MUTATION_RETRY_DELAY = 3_000;

/**
 * Invalidate stream queries after a mutation with a staggered retry.
 * First invalidation fires after POST_MUTATION_DELAY, and a second
 * one fires after POST_MUTATION_RETRY_DELAY to catch slower updates.
 */
function invalidateStreamsAfterMutation(queryClient: ReturnType<typeof useQueryClient>) {
  // Immediate invalidation (cache mark as stale)
  queryClient.invalidateQueries({ queryKey: ['streams'] });
  queryClient.invalidateQueries({ queryKey: ['stream'] });
  queryClient.invalidateQueries({ queryKey: ['stream-history'] });

  // Delayed refetch to catch Canton ACS propagation
  setTimeout(() => {
    queryClient.invalidateQueries({ queryKey: ['streams'] });
    queryClient.invalidateQueries({ queryKey: ['stream'] });
    queryClient.invalidateQueries({ queryKey: ['stream-history'] });
  }, POST_MUTATION_DELAY);

  // Second retry for slower propagation
  setTimeout(() => {
    queryClient.invalidateQueries({ queryKey: ['streams'] });
    queryClient.invalidateQueries({ queryKey: ['stream'] });
    queryClient.invalidateQueries({ queryKey: ['stream-history'] });
  }, POST_MUTATION_RETRY_DELAY);
}

export function useStreams(filter?: StreamFilter) {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['streams', filter],
    queryFn: () => client!.listStreams(filter),
    enabled: !!client,
    refetchInterval: 15_000,
  });
}

export function usePendingStreamRequests(filter?: PendingStreamRequestFilter) {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['stream-requests', filter],
    queryFn: () => client!.listPendingStreamRequests(filter),
    enabled: !!client,
    refetchInterval: 10_000,
  });
}

export function useStream(sender: string, streamId: string) {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['stream', sender, streamId],
    queryFn: () => client!.getStream(sender, streamId),
    enabled: !!client && !!sender && !!streamId,
    refetchInterval: 10_000,
  });
}

export function useStreamHistory(sender: string, streamId: string) {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['stream-history', sender, streamId],
    queryFn: () => client!.getStreamHistory(sender, streamId),
    enabled: !!client && !!sender && !!streamId,
    refetchInterval: 30_000,
  });
}

export function useCreateStream() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: CreateStreamParams) => client!.createStream(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      queryClient.invalidateQueries({ queryKey: ['stream-requests'] });
      // Staggered refetch for request list
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['stream-requests'] });
      }, POST_MUTATION_DELAY);
    },
  });
}

export function useAcceptStream() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sender, streamId }: { sender: string; streamId: string }) =>
      client!.acceptStream(sender, streamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stream-requests'] });
      invalidateStreamsAfterMutation(queryClient);
    },
  });
}

export function useWithdraw() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sender, streamId }: { sender: string; streamId: string }) =>
      client!.withdraw(sender, streamId),
    onSuccess: () => {
      invalidateStreamsAfterMutation(queryClient);
    },
  });
}

export function useCancel() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sender,
      streamId,
      mutual,
    }: {
      sender: string;
      streamId: string;
      mutual?: boolean;
    }) =>
      mutual
        ? client!.mutualCancel(sender, streamId)
        : client!.cancel(sender, streamId),
    onSuccess: () => {
      invalidateStreamsAfterMutation(queryClient);
    },
  });
}

export function useRenew() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sender,
      streamId,
      params,
    }: {
      sender: string;
      streamId: string;
      params: RenewParams;
    }) => client!.renew(sender, streamId, params),
    onSuccess: () => {
      invalidateStreamsAfterMutation(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// V1 streams (proxy /api/v1/streams group)
//
// Distinct query keys (`streams-v1` / `stream-v1`) so V1 invalidation never
// races V2 ACS refetches. V1 state is proxy-side bookkeeping (settled
// cycles), so a single delayed refetch after a settle is enough.
// ---------------------------------------------------------------------------

export function useStreamsV1() {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['streams-v1'],
    queryFn: () => client!.listStreamsV1(),
    enabled: !!client,
    refetchInterval: 15_000,
  });
}

export function useStreamV1(id: string) {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['stream-v1', id],
    queryFn: () => client!.getStreamV1(id),
    enabled: !!client && !!id,
    refetchInterval: 10_000,
  });
}

/** Ledger-backed incoming view for the connected party: pending offers awaiting
 * accept + CC already delivered. Read straight from the participant, so it
 * surfaces EVERY transfer to the party — including raw-registry and wallet-sent
 * ones the proxy store never tracked (which `useStreamsV1` cannot show). */
export function useReceivedV1() {
  const client = useCantonClient();
  const { party, devMode } = useAuth();
  // A wallet party (e.g. Loop) is hosted on ITS OWN participant, not the proxy's,
  // so the proxy's /api/v1/received sees nothing for it — read via the wallet's
  // ledgerApi instead. A dev-mode/hosted party (streamsbob) uses the proxy, which
  // hosts it. `isHostedLedgerAvailable` only reports adapter capabilities, so gate
  // on `!devMode` to avoid routing a dev session to a dead wallet.
  const useWallet = !devMode && isHostedLedgerAvailable() && !!party;

  return useQuery({
    queryKey: ['received-v1', useWallet ? `wallet:${party}` : 'proxy'],
    queryFn: () => (useWallet ? listReceivedViaWallet(party!) : client!.listReceivedV1()),
    enabled: !!client && (!useWallet || !!party),
    refetchInterval: 12_000,
  });
}

/** Accept a pending incoming offer by contract id. A hosted / dev-mode recipient
 * (e.g. streamsbob) has the proxy submit TransferInstruction_Accept on its
 * participant; a wallet party (e.g. Loop) has the proxy build the command and
 * the wallet sign+submit it. Either way the delivered CC then moves out of
 * `pending` on the next refetch. */
export function useAcceptReceivedV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  const { party, devMode } = useAuth();

  return useMutation({
    mutationFn: (transferInstructionCid: string) => {
      if (!devMode && isHostedLedgerAvailable() && party) {
        return acceptReceivedViaWallet(client!, party, transferInstructionCid);
      }
      return client!.acceptReceivedV1(transferInstructionCid);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['received-v1'] });
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
    },
  });
}

export function useCreateStreamV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: V1CreateStreamParams) => client!.createStreamV1(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
    },
  });
}

export function useSettleStreamV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  const { devMode } = useAuth();

  return useMutation({
    mutationFn: ({
      id,
      params,
      payerParty,
      recipientParty,
      asset,
    }: {
      id: string;
      params?: V1SettleParams;
      payerParty?: string;
      /** The stream recipient — lets a non-CC settle bind its proof-of-transfer
       *  to the delivery that lands on the recipient. */
      recipientParty?: string;
      /** The stream's settlement instrument (absent ⇒ Canton Coin). Threaded so
       *  a non-CC wallet settle reads the right holdings, not Amulet. */
      asset?: StreamInstrument;
    }) => {
      // Model 2: when the payer is a hosted (wallet-held) party, the transfer
      // must be signed + submitted through the WALLET'S participant. Otherwise
      // (a party this proxy hosts, including a dev-mode session with no live
      // wallet) fall back to the proxy submit (model 1). `isHostedLedgerAvailable`
      // only reports adapter CAPABILITIES, so it stays true even when no wallet
      // is actually connected — gate on `!devMode` to require a real session.
      if (payerParty && !devMode && isHostedLedgerAvailable()) {
        return settleV1ViaWallet(client!, id, payerParty, {
          ...(params ?? {}),
          ...(recipientParty ? { recipientParty } : {}),
          ...(asset?.id ? { assetInstrumentId: asset.id } : {}),
          ...(asset?.admin ? { assetInstrumentAdmin: asset.admin } : {}),
          ...(asset?.holdingTemplateId ? { assetHoldingTemplateId: asset.holdingTemplateId } : {}),
        });
      }
      return client!.settleStreamV1(id, params);
    },
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
      queryClient.invalidateQueries({ queryKey: ['stream-v1', id] });
      // A settle just drew from the wallet — refresh the balances the funding
      // strip reads, otherwise they poll slowly and show a pre-settle figure.
      queryClient.invalidateQueries({ queryKey: ['wallet-holdings'] });
      queryClient.invalidateQueries({ queryKey: ['asset-balance'] });
    },
  });
}

/** Stop a V1 stream (payer only) — halts accrual + settlement. */
export function useStopStreamV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string }) => client!.stopStreamV1(id),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
      queryClient.invalidateQueries({ queryKey: ['stream-v1', id] });
    },
  });
}

/**
 * Sender-side "Send for claim" (receiver-claim escrow). Alice's wallet locks one
 * cycle into a V1 allocation and signs `ReceiverClaimV1` once, so Bob can later
 * claim without Alice. This requires `canton-streams-v1-shim` to be vetted on
 * the payer's participant, so it is for controlled validators, not arbitrary
 * hosted wallets such as Loop.
 */
export function useFundReceiverClaimV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payerParty,
      opts,
    }: {
      id: string;
      payerParty: string;
      opts?: { force?: boolean; amount?: string; unlockAt?: string; expiresAt?: string };
    }) => fundReceiverClaimV1ViaWallet(client!, id, payerParty, opts ?? {}),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
      queryClient.invalidateQueries({ queryKey: ['stream-v1', id] });
    },
  });
}

/**
 * Receiver-side claim. Bob's wallet signs `ReceiverClaimV1.Claim` (the proxy
 * supplies the live registry execute-transfer context); the proxy records only
 * after Scan confirms the update id. Requires the same custom-DAR deployment as
 * `useFundReceiverClaimV1`.
 */
export function useClaimV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      recipientParty,
      selector,
    }: {
      id: string;
      recipientParty: string;
      selector?: { cycle?: number; allocationCid?: string; receiverClaimCid?: string };
    }) => claimV1ViaWallet(client!, id, recipientParty, selector ?? {}),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
      queryClient.invalidateQueries({ queryKey: ['stream-v1', id] });
    },
  });
}

/**
 * Receiver-side "Accept" of a pending transfer offer. Bob's wallet signs
 * `TransferInstruction_Accept`; the proxy records the delivered cycle only after
 * Scan confirms it. Hosted-wallet only — the recipient signs via its participant.
 */
export function useAcceptTransferV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  const { devMode } = useAuth();

  return useMutation({
    mutationFn: ({
      id,
      recipientParty,
      selector,
    }: {
      id: string;
      recipientParty: string;
      selector?: { cycle?: number; transferInstructionCid?: string };
    }) => {
      // Loop/external recipient → wallet signs the accept (model 2). A hosted /
      // dev-mode recipient (e.g. a validator-local party such as streamsbob) has
      // no browser wallet, so the proxy submits the accept on its participant
      // (model 1). `isHostedLedgerAvailable` only reports adapter CAPABILITIES,
      // so it stays true for a dev-mode session with no live wallet — gate on
      // `!devMode` so the accept routes to the proxy instead of a dead session.
      if (!devMode && isHostedLedgerAvailable()) {
        return acceptTransferV1ViaWallet(client!, id, recipientParty, selector ?? {});
      }
      return client!.acceptTransferV1(id, selector ?? {});
    },
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
      queryClient.invalidateQueries({ queryKey: ['stream-v1', id] });
    },
  });
}

/**
 * Sender-side "Withdraw / retry" of a pending offer the recipient never
 * accepted. Alice's wallet signs `TransferInstruction_Withdraw`, reclaiming the
 * locked CC; the proxy records the reclaim only after Scan confirms it.
 */
export function useWithdrawTransferV1() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payerParty,
      selector,
    }: {
      id: string;
      payerParty: string;
      selector?: { cycle?: number; transferInstructionCid?: string };
    }) => withdrawTransferV1ViaWallet(client!, id, payerParty, selector ?? {}),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['streams-v1'] });
      queryClient.invalidateQueries({ queryKey: ['stream-v1', id] });
    },
  });
}
