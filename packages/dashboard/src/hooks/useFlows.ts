/**
 * TanStack Query hooks for open-ended flows (StreamFlow).
 *
 * Mirrors useStreams.ts: REST proxy API client, query-key invalidation
 * with a staggered refetch to ride out Canton ACS propagation (every
 * flow choice archives + recreates the contract).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateFlowRequest } from '../api/client.js';
import { useCantonClient } from './useCantonClient.js';

const POST_MUTATION_DELAY = 1_500;
const POST_MUTATION_RETRY_DELAY = 3_000;

function invalidateFlowsAfterMutation(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['flows'] });
  setTimeout(() => {
    queryClient.invalidateQueries({ queryKey: ['flows'] });
  }, POST_MUTATION_DELAY);
  setTimeout(() => {
    queryClient.invalidateQueries({ queryKey: ['flows'] });
  }, POST_MUTATION_RETRY_DELAY);
}

export function useFlows(filter?: { sender?: string; recipient?: string }) {
  const client = useCantonClient();

  return useQuery({
    queryKey: ['flows', filter],
    queryFn: () => client!.listFlows(filter),
    enabled: !!client,
    refetchInterval: 15_000,
  });
}

export function useCreateFlow() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: CreateFlowRequest) => client!.createFlow(params),
    onSuccess: () => {
      invalidateFlowsAfterMutation(queryClient);
    },
  });
}

export function useTopUpFlow() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sender,
      flowId,
      topUpAmount,
      settlementReference,
    }: {
      sender: string;
      flowId: string;
      topUpAmount: string;
      settlementReference: string;
    }) => client!.topUpFlow(sender, flowId, { topUpAmount, settlementReference }),
    onSuccess: () => {
      invalidateFlowsAfterMutation(queryClient);
    },
  });
}

export function useWithdrawFlow() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sender,
      flowId,
      settlementReference,
    }: {
      sender: string;
      flowId: string;
      settlementReference: string;
    }) => client!.withdrawFlow(sender, flowId, { settlementReference }),
    onSuccess: () => {
      invalidateFlowsAfterMutation(queryClient);
    },
  });
}

export function useStopFlow() {
  const client = useCantonClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sender,
      flowId,
      recipientSettlement,
      senderRefund,
      recipientSettlementReference,
      senderRefundReference,
    }: {
      sender: string;
      flowId: string;
      recipientSettlement: string;
      senderRefund: string;
      recipientSettlementReference?: string;
      senderRefundReference?: string;
    }) =>
      client!.stopFlow(sender, flowId, {
        recipientSettlement,
        senderRefund,
        ...(recipientSettlementReference ? { recipientSettlementReference } : {}),
        ...(senderRefundReference ? { senderRefundReference } : {}),
      }),
    onSuccess: () => {
      invalidateFlowsAfterMutation(queryClient);
    },
  });
}
