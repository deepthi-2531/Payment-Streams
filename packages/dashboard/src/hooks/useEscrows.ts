/**
 * TanStack Query hooks for operator-custodied escrow streams
 * (proxy /api/v1/escrows group).
 *
 * The create path routes like the V1 settle: a wallet-held payer (Loop) signs
 * the single deposit through its own participant (model 2); a party this proxy
 * hosts, or a dev-mode session, lets the proxy submit the deposit (model 1).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateEscrowParams, EscrowView } from '../api/client.js';
import { useCantonClient } from './useCantonClient.js';
import { useAuth } from '../store/auth.js';
import { isHostedLedgerAvailable } from '../lib/hostedWalletLedger.js';
import { createEscrowViaWallet } from '../lib/escrowDeposit.js';

export function useEscrows() {
  const client = useCantonClient();
  return useQuery({
    queryKey: ['escrows'],
    queryFn: () => client!.listEscrows(),
    enabled: !!client,
    refetchInterval: 12_000,
  });
}

export function useEscrow(id: string) {
  const client = useCantonClient();
  return useQuery({
    queryKey: ['escrow', id],
    queryFn: () => client!.getEscrow(id),
    enabled: !!client && !!id,
    // The streamer releases on a cadence — poll fast enough to see cycles land.
    refetchInterval: 8_000,
  });
}

export function useEscrowInfo() {
  const client = useCantonClient();
  return useQuery({
    queryKey: ['escrow-info'],
    queryFn: () => client!.escrowInfo(),
    enabled: !!client,
    staleTime: 5 * 60_000,
  });
}

/** Reconcile the audit trail against the chain. Polls while the escrow is live
 * so pending offers flip to delivered as the payee accepts. */
export function useReconcileEscrow(id: string, enabled = true) {
  const client = useCantonClient();
  return useQuery({
    queryKey: ['escrow-reconcile', id],
    queryFn: () => client!.reconcileEscrow(id),
    enabled: !!client && !!id && enabled,
    refetchInterval: 15_000,
  });
}

export function useCreateEscrow() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  const { party, devMode } = useAuth();

  return useMutation({
    mutationFn: (params: CreateEscrowParams): Promise<EscrowView> => {
      const payerParty = params.payerParty ?? party ?? undefined;
      // Model 2: a wallet-held payer signs the deposit through its own
      // participant. `isHostedLedgerAvailable` only reports adapter capabilities,
      // so gate on `!devMode` to require a real connected wallet.
      if (payerParty && !devMode && isHostedLedgerAvailable()) {
        return createEscrowViaWallet(client!, { ...params, payerParty });
      }
      // Model 1: the proxy submits the deposit (hosted / dev-mode payer).
      return client!.createEscrow({ ...params, payerParty });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['escrows'] });
    },
  });
}

export function useRefundEscrow() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => client!.refundEscrow(id),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['escrows'] });
      queryClient.invalidateQueries({ queryKey: ['escrow', id] });
    },
  });
}
