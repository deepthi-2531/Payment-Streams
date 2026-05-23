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
import { useCantonClient } from './useCantonClient.js';

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
