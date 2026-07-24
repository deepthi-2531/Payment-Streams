/**
 * V1StreamDetailPage — single V1 stream (GET /api/v1/streams/:id) with a
 * "Settle now" button (POST /api/v1/streams/:id/settle).
 *
 * Shows the agreement terms, accrued/due, the on-ledger StreamAdmin
 * projection when present, and the full settled-cycle history. "Settle now"
 * triggers one settle cycle and refreshes; a "force" toggle lets the demo
 * settle exactly one cycle even when nothing has accrued yet.
 *
 * The route param is `:id` (the agreement / stream id), distinct from the
 * V2 `:sender/:streamId` detail route.
 */

import { useState, type ReactNode } from 'react';
import { useParams, Link } from 'react-router';
import {
  ChevronLeft, Zap, Loader2, Check, Clock, ExternalLink, Send, HandCoins, Undo2, Square, ShieldCheck,
} from 'lucide-react';
import {
  useStreamV1,
  useSettleStreamV1,
  useStopStreamV1,
  useFundReceiverClaimV1,
  useClaimV1,
  useAcceptTransferV1,
  useWithdrawTransferV1,
} from '../hooks/useStreams.js';
import { useCantonCoinBalance } from '../hooks/useCantonCoinBalance.js';
import { useAssetBalance } from '../hooks/useAssetBalance.js';
import { useAuth } from '../store/auth.js';
import { partyShort } from '../components/primitives/PartyChip.js';
import { explorerUpdateUrl, explorerName, isVerifiableUpdateId } from '../lib/scanLink.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';
import type {
  V1Agreement,
  V1SettleResult,
  V1StreamView,
  V1ReceiverClaimRecord,
  V1PendingTransferRecord,
} from '../api/client.js';

const ENABLE_V1_RECEIVER_CLAIM = import.meta.env.VITE_ENABLE_V1_RECEIVER_CLAIM === 'true';

export function V1StreamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const streamQ = useStreamV1(id ?? '');

  if (!id) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader title="Stream not found" />
        <ErrorState error={new Error('Missing stream id in URL.')} title="Bad URL" />
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 28 }}>
      <div style={{ marginBottom: 18 }}>
        <Link
          to="/v1/streams"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: 'var(--fg-3)',
            textDecoration: 'none',
          }}
        >
          <ChevronLeft size={14} />
          Back to V1 streams
        </Link>
      </div>

      {streamQ.isPending && (
        <>
          <Skeleton height={32} width={420} style={{ marginBottom: 16 }} />
          <Skeleton.Card minHeight={200} />
          <div style={{ height: 12 }} />
          <Skeleton.Row count={3} height={56} />
        </>
      )}

      {streamQ.isError && (
        <ErrorState
          error={streamQ.error}
          title="Could not load V1 stream"
          onRetry={() => streamQ.refetch()}
        />
      )}

      {streamQ.data && <V1Detail id={id} view={streamQ.data} />}
    </div>
  );
}

function V1Detail({ id, view }: { readonly id: string; readonly view: V1StreamView }) {
  const { agreement, state, accrued, due, onLedger } = view;
  const { party } = useAuth();
  const settle = useSettleStreamV1();
  const stop = useStopStreamV1();
  const fund = useFundReceiverClaimV1();
  const claim = useClaimV1();
  const accept = useAcceptTransferV1();
  const withdraw = useWithdrawTransferV1();
  const isCc = !agreement.assetKey || agreement.assetKey.trim().toLowerCase() === 'cc';
  const cc = useCantonCoinBalance();
  // Non-CC streams show the wallet's balance of that asset, not CC.
  const asset = useAssetBalance(agreement.payerParty, isCc ? undefined : agreement.instrument);
  const bal = isCc ? cc : asset;
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<V1SettleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fundNote, setFundNote] = useState<string | null>(null);

  const isPayer = !!party && party === agreement.payerParty;
  const isRecipient = !!party && party === agreement.recipientParty;
  const isStopped = agreement.status === 'stopped';
  const unit = streamUnit(agreement);

  const onStop = async () => {
    if (!window.confirm('Stop this stream? It will no longer accrue or settle. This cannot be undone.')) return;
    setError(null);
    try {
      await stop.mutateAsync({ id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stop failed');
    }
  };

  // Receiver-claim records are shown only when the deployment explicitly opts
  // into the custom-DAR path. Public hosted-wallet demos use direct delivery.
  const claims: readonly V1ReceiverClaimRecord[] = state.receiverClaims ?? [];
  const nowMs = Date.now();
  const nextClaim = claims.find((c) => c.status === 'claim_ready' && !!c.receiverClaimCid);
  const claimUnlocked = !!nextClaim && Date.parse(nextClaim.unlockAt) <= nowMs;

  // Pending offers (DAR-less flow): a cycle whose transfer landed as a
  // TransferInstruction because the recipient had no pre-approval. The recipient
  // accepts it; the sender can withdraw/retry once it expires.
  const pending: readonly V1PendingTransferRecord[] = state.pendingTransfers ?? [];
  const openOffers = pending.filter((p) => p.status === 'pending');
  const nextOffer = [...openOffers].sort((a, b) => a.cycle - b.cycle)[0];

  // What pressing Settle would actually draw from the wallet, in CC: the amount
  // due this cycle, or exactly one rate when nothing is due but "Force" is on.
  const rateNum = Number(agreement.ratePerPeriod);
  const dueNum = Number(due);
  const settleCost = force ? rateNum : dueNum > 0 ? dueNum : rateNum;
  const lowBalance =
    isPayer && bal.value !== null && Number.isFinite(settleCost) && bal.value < settleCost;

  const onSettle = async () => {
    setError(null);
    setResult(null);
    try {
      const res = await settle.mutateAsync({
        id,
        params: force ? { force: true } : {},
        // Lets the hook route through the wallet (model 2) when the payer is a
        // hosted (wallet-held) party rather than one this proxy hosts.
        payerParty: agreement.payerParty,
        // Binds a non-CC settle's proof-of-transfer to the delivery recipient.
        recipientParty: agreement.recipientParty,
        // Non-CC streams read the payer's holdings of their own asset, not CC.
        asset: agreement.instrument,
      });
      // Honesty gate: a `settled` result is only real if it carries a verifiable
      // on-ledger update id. If the backend ever returns settled===true without
      // one, treat it as a failure — never paint a green "settled" banner that
      // can't be checked on Scan.
      if (res.settled && !isVerifiableUpdateId(res.updateId)) {
        setError(
          'The settle returned no verifiable on-ledger transaction id, so it is NOT confirmed on chain. ' +
            'Nothing should be treated as paid — retry and approve the wallet signature prompt.',
        );
        return;
      }
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settle failed');
    }
  };

  // Sender escrows one cycle for the recipient to claim (locks CC + signs
  // ReceiverClaimV1 once). Controlled-validator/custom-DAR deployments only.
  const onSendForClaim = async () => {
    setError(null);
    setResult(null);
    setFundNote(null);
    try {
      const rec = await fund.mutateAsync({
        id,
        payerParty: agreement.payerParty,
        opts: force ? { force: true } : {},
      });
      if ('funded' in rec && rec.funded === false) {
        setFundNote(`Nothing to send this cycle (${rec.reason}).`);
      } else {
        const r = rec as V1ReceiverClaimRecord;
        const who = agreement.recipientParty.split('::')[0];
        setFundNote(
          `Escrowed ${fmtCC(r.amount, unit)} for ${who} to claim` +
            (Date.parse(r.unlockAt) > nowMs ? ` after ${fmt(r.unlockAt)}.` : ' now.'),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send for claim failed');
    }
  };

  // Recipient claims the next ready allocation. Bob's wallet signs the claim;
  // the proxy records it only after Scan confirms (same honesty gate as settle).
  const onClaim = async () => {
    setError(null);
    setResult(null);
    setFundNote(null);
    try {
      const res = await claim.mutateAsync({
        id,
        recipientParty: agreement.recipientParty,
        selector: nextClaim ? { cycle: nextClaim.cycle } : {},
      });
      if (res.settled && !isVerifiableUpdateId(res.updateId)) {
        setError(
          'The claim returned no verifiable on-ledger transaction id, so it is NOT confirmed on chain. ' +
            'Retry and approve the wallet signature prompt.',
        );
        return;
      }
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed');
    }
  };

  // Recipient accepts a pending offer. Bob's wallet signs TransferInstruction_Accept;
  // the proxy records the delivered cycle only after Scan confirms (honesty gate).
  const onAccept = async (offer?: V1PendingTransferRecord) => {
    const target = offer ?? nextOffer;
    if (!target) return;
    setError(null);
    setResult(null);
    setFundNote(null);
    try {
      const res = await accept.mutateAsync({
        id,
        recipientParty: agreement.recipientParty,
        selector: { transferInstructionCid: target.transferInstructionCid },
      });
      if (res.settled && !isVerifiableUpdateId(res.updateId)) {
        setError(
          'The acceptance returned no verifiable on-ledger transaction id, so it is NOT confirmed ' +
            'on chain. Retry and approve the wallet signature prompt.',
        );
        return;
      }
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    }
  };

  // Sender reclaims an unaccepted offer (retry path). Alice's wallet signs
  // TransferInstruction_Withdraw; the locked CC returns to her wallet.
  const onWithdraw = async (offer: V1PendingTransferRecord) => {
    setError(null);
    setResult(null);
    setFundNote(null);
    try {
      const res = await withdraw.mutateAsync({
        id,
        payerParty: agreement.payerParty,
        selector: { transferInstructionCid: offer.transferInstructionCid },
      });
      if (res.withdrawn) {
        const who = agreement.recipientParty.split('::')[0];
        setFundNote(
          `Reclaimed the unaccepted offer to ${who}. The CC is back in your wallet — Settle again to retry.`,
        );
      } else {
        setFundNote(`Could not withdraw the offer (${res.reason ?? 'unknown'}).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="mono" style={{ fontSize: 22 }}>
            {agreement.agreementId}
          </span>
        }
        subtitle={`${agreement.cadence} · ${agreement.arrearsPolicy} · created ${fmt(agreement.createdAt)}${isStopped ? ' · stopped' : ''}`}
        actions={
          isStopped ? (
            <span
              className="badge"
              style={{
                fontSize: 12,
                padding: '6px 12px',
                background: 'var(--bg-elev)',
                color: 'var(--fg-3)',
                border: '1px solid var(--line-2)',
              }}
            >
              <Square size={12} style={{ marginRight: 6 }} /> Stream stopped
            </span>
          ) : isPayer ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--fg-3)',
                cursor: 'pointer',
              }}
              title={`Settle exactly one cycle (${fmtCC(agreement.ratePerPeriod, unit)}) now, even if nothing has accrued yet. This still draws real funds from your wallet.`}
            >
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Settle one cycle now (demo)
            </label>
            {ENABLE_V1_RECEIVER_CLAIM && (
              <button
                className="btn btn-ghost"
                onClick={onSendForClaim}
                disabled={fund.isPending}
                title="Escrow one cycle for the recipient to claim. Requires the Streams V1 shim DAR on the payer participant."
                style={{ minWidth: 150, justifyContent: 'center' }}
              >
                {fund.isPending ? (
                  <>
                    <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} /> Sending…
                  </>
                ) : (
                  <>
                    <Send size={14} /> Send for claim
                  </>
                )}
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={onSettle}
              disabled={settle.isPending}
              title="Push one cycle directly to the recipient now (no escrow)."
              style={{ minWidth: 140, justifyContent: 'center' }}
            >
              {settle.isPending ? (
                <>
                  <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} /> Settling…
                </>
              ) : (
                <>
                  <Zap size={14} /> Settle now
                </>
              )}
            </button>
            <button
              className="btn btn-ghost"
              onClick={onStop}
              disabled={stop.isPending}
              title="Stop this stream — halts all future accrual and settlement."
              style={{ minWidth: 90, justifyContent: 'center', color: 'var(--danger, #e5484d)' }}
            >
              {stop.isPending ? (
                <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} />
              ) : (
                <>
                  <Square size={13} /> Stop
                </>
              )}
            </button>
          </div>
          ) : isRecipient ? (
            nextOffer ? (
              <button
                className="btn btn-primary"
                onClick={() => onAccept(nextOffer)}
                disabled={accept.isPending}
                title={`Accept ${fmtCC(nextOffer.amount, unit)} that ${agreement.payerParty.split('::')[0]} sent you.`}
                style={{ minWidth: 160, justifyContent: 'center' }}
              >
                {accept.isPending ? (
                  <>
                    <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} /> Accepting…
                  </>
                ) : (
                  <>
                    <HandCoins size={14} /> Accept {fmtCC(nextOffer.amount, unit)}
                  </>
                )}
              </button>
            ) : ENABLE_V1_RECEIVER_CLAIM && nextClaim ? (
              <button
                className="btn btn-primary"
                onClick={onClaim}
                disabled={claim.isPending || !claimUnlocked}
                title={
                  claimUnlocked
                    ? `Claim ${fmtCC(nextClaim.amount, unit)} the sender escrowed for you.`
                    : `Unlocks ${fmt(nextClaim.unlockAt)} — you can claim after that.`
                }
                style={{ minWidth: 160, justifyContent: 'center' }}
              >
                {claim.isPending ? (
                  <>
                    <Loader2 size={14} style={{ animation: 'spin 800ms linear infinite' }} /> Claiming…
                  </>
                ) : claimUnlocked ? (
                  <>
                    <HandCoins size={14} /> Claim {fmtCC(nextClaim.amount, unit)}
                  </>
                ) : (
                  <>
                    <Clock size={14} /> Claim unlocks {fmt(nextClaim.unlockAt)}
                  </>
                )}
              </button>
            ) : (
              <span
                className="badge"
                title="You are the recipient; nothing is waiting for you to accept yet."
                style={{ fontSize: 11.5 }}
              >
                Receiving · nothing to accept yet
              </span>
            )
          ) : (
            <span
              className="badge"
              title="Read-only: you are neither the payer nor the recipient of this stream."
              style={{ fontSize: 11.5 }}
            >
              Read-only
            </span>
          )
        }
      />

      {fundNote && (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 18,
            fontSize: 12.5,
            color: 'var(--fg-2)',
            borderColor: 'color-mix(in oklab, var(--accent) 35%, var(--line))',
          }}
        >
          <Send size={13} style={{ color: 'var(--accent)', marginRight: 6, verticalAlign: 'middle' }} />
          {fundNote}
        </div>
      )}

      {isPayer && !ENABLE_V1_RECEIVER_CLAIM && (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 18,
            fontSize: 12.5,
            color: 'var(--fg-2)',
            lineHeight: 1.5,
          }}
        >
          Each <strong style={{ color: 'var(--fg)' }}>Settle</strong> is signed by your wallet and uses
          only network-vetted token-standard packages (no custom DAR). If the recipient has a{' '}
          <strong style={{ color: 'var(--fg)' }}>TransferPreapproval</strong> the CC lands directly;
          otherwise it becomes a <strong style={{ color: 'var(--fg)' }}>pending offer</strong> they
          accept in their own wallet — and you can withdraw/retry it if they don’t accept before it expires.
        </div>
      )}

      {/* Funding strip — payer only. Shows what one Settle costs and the live
          wallet balance up front, so a shortfall is visible before clicking
          rather than surfacing as a cryptic error at submit time. */}
      {isPayer && (
        <div
          className="card"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 16px',
            marginBottom: 18,
            borderColor: lowBalance
              ? 'color-mix(in oklab, var(--warn) 45%, var(--line))'
              : 'var(--line-2)',
          }}
        >
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            Each <strong>Settle</strong> draws{' '}
            <span className="mono" style={{ color: 'var(--fg)' }}>{fmtCC(String(settleCost), unit)}</span>{' '}
            from your wallet to{' '}
            <span title={agreement.recipientParty}>{agreement.recipientParty.split('::')[0]}</span>.
          </div>
          <div style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--fg-4)' }}>Wallet balance</span>
            <span className="mono" style={{ color: lowBalance ? 'var(--warn)' : 'var(--fg)' }}>
              {bal.isLoading ? '…' : bal.display !== null ? fmtCC(bal.display, unit) : '—'}
            </span>
          </div>
          {lowBalance && (
            <div style={{ flexBasis: '100%', fontSize: 12, color: 'var(--warn)' }}>
              Not enough {unit} for this cycle — top up your wallet with at least{' '}
              {fmtCC(String(Math.max(0, settleCost - (bal.value ?? 0))), unit)} more, then retry.
            </div>
          )}
        </div>
      )}

      {/* Settle result banner */}
      {result && <SettleBanner result={result} rate={agreement.ratePerPeriod} unit={unit} />}
      {error && <SettleErrorCard message={error} balance={bal.display} unit={unit} />}

      {/* Metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 14,
          marginBottom: 18,
        }}
      >
        <Metric label="Rate / cycle" value={agreement.ratePerPeriod} suffix={unit} mono />
        <Metric label="Accrued (now)" value={accrued} suffix={unit} mono />
        <Metric label="Due this cycle" value={due} suffix={unit} mono accent />
        <Metric label="Settled cycles" value={String(state.cycles)} />
        <Metric label="Total settled" value={String(state.settled)} suffix={unit} mono />
        {isPayer && (
          <Metric
            label="Wallet balance"
            value={bal.isLoading ? '…' : bal.display ?? '—'}
            suffix={!bal.isLoading && bal.display !== null ? unit : undefined}
            mono
          />
        )}
      </div>

      {/* Agreement terms */}
      <div className="card" style={{ padding: 22, marginBottom: 18 }}>
        <SectionTitle>Agreement</SectionTitle>
        <Row label="Payer" value={partyLine(agreement.payerParty)} />
        <Row label="Recipient" value={partyLine(agreement.recipientParty)} />
        <Row
          label="Reference amount"
          value={
            <span>
              <span className="mono">{fmtCC(agreement.totalDeposited, unit)}</span>{' '}
              <span style={{ color: 'var(--fg-4)', fontSize: 11 }}>· direct-delivery mode does not prefund</span>
            </span>
          }
        />
        <Row label="Effective from" value={fmt(agreement.effectiveFrom)} />
        {agreement.termEnd && <Row label="Term end" value={fmt(agreement.termEnd)} />}
        {agreement.appId && <Row label="App id" value={<span className="mono">{agreement.appId}</span>} />}
        {agreement.streamAdminCid && (
          <Row
            label="StreamAdmin cid"
            value={<span className="mono" style={{ fontSize: 11 }}>{agreement.streamAdminCid}</span>}
          />
        )}
      </div>

      {/* On-ledger projection */}
      {onLedger && (
        <div className="card" style={{ padding: 22, marginBottom: 18 }}>
          <SectionTitle>On-ledger (StreamAdmin)</SectionTitle>
          <Row label="Contract id" value={<span className="mono" style={{ fontSize: 11 }}>{onLedger.contractId}</span>} />
          <Row label="Status" value={<span className="badge">{onLedger.status}</span>} />
          <Row label="Total withdrawn" value={<span className="mono">{onLedger.totalWithdrawn}</span>} />
          <Row label="Iterations" value={<span className="mono">{onLedger.numIterations}</span>} />
          <Row
            label="Current allocation"
            value={<span className="mono" style={{ fontSize: 11 }}>{onLedger.currentAllocationCid}</span>}
          />
        </div>
      )}

      {/* Pending offers (sender settled → recipient accepts) */}
      {pending.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
          <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
            <SectionTitle>Pending offers · awaiting acceptance</SectionTitle>
          </div>
          {[...pending].reverse().map((p, i) => {
            const expired = Date.parse(p.executeBefore) <= nowMs;
            const isOpen = p.status === 'pending';
            // Reclaimable = an open offer whose accept-by deadline has passed (or
            // one the proxy already flagged 'expired'). The sender's CC is still
            // locked on-ledger and can be claimed back via the withdraw path.
            const isExpiredStatus = p.status === 'expired';
            const reclaimable = (isOpen && expired) || isExpiredStatus;
            const last = i === pending.length - 1;
            return (
              <div
                key={p.transferInstructionCid}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '0.7fr 1fr 1.3fr 1.7fr',
                  gap: 14,
                  alignItems: 'center',
                  padding: '12px 22px',
                  borderBottom: last ? 'none' : '1px solid var(--line)',
                }}
              >
                <span className="badge" style={{ fontSize: 11, justifySelf: 'start' }}>
                  {p.ref.split(':').pop()}
                </span>
                <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>{fmtCC(p.amount, unit)}</span>
                <div>
                  <span
                    className="badge"
                    style={{
                      fontSize: 11,
                      color: reclaimable
                        ? 'var(--warn)'
                        : p.status === 'accepted'
                          ? 'var(--accent)'
                          : 'var(--fg-2)',
                    }}
                  >
                    {reclaimable ? 'Expired — reclaimable' : pendingStatusLabel(p.status)}
                  </span>
                  <span style={{ display: 'block', fontSize: 10.5, color: reclaimable ? 'var(--warn)' : 'var(--fg-4)', marginTop: 4 }}>
                    {isOpen || isExpiredStatus ? (expired ? `expired ${fmt(p.executeBefore)}` : `expires ${fmt(p.executeBefore)}`) : ''}
                  </span>
                </div>
                <div style={{ minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
                  {isOpen && isRecipient && !expired ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => onAccept(p)}
                      disabled={accept.isPending}
                      style={{ minWidth: 96, justifyContent: 'center', padding: '6px 12px', fontSize: 12 }}
                    >
                      {accept.isPending ? (
                        <Loader2 size={13} style={{ animation: 'spin 800ms linear infinite' }} />
                      ) : (
                        <><HandCoins size={13} /> Accept</>
                      )}
                    </button>
                  ) : (isOpen || isExpiredStatus) && isPayer ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => onWithdraw(p)}
                      disabled={withdraw.isPending}
                      title={reclaimable
                        ? 'This offer expired unaccepted — claim the locked CC back to your wallet.'
                        : 'Reclaim the offer early (the recipient has not accepted yet).'}
                      style={{ minWidth: 96, justifyContent: 'center', padding: '6px 12px', fontSize: 12 }}
                    >
                      {withdraw.isPending ? (
                        <Loader2 size={13} style={{ animation: 'spin 800ms linear infinite' }} />
                      ) : (
                        <><Undo2 size={13} /> {reclaimable ? 'Claim back' : 'Withdraw'}</>
                      )}
                    </button>
                  ) : isVerifiableUpdateId(p.finalUpdateId) ? (
                    <a
                      href={explorerUpdateUrl(p.finalUpdateId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono"
                      style={{ fontSize: 10.5, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={p.finalUpdateId}
                    >
                      {p.status} · {p.finalUpdateId} ↗
                    </a>
                  ) : (isOpen || isExpiredStatus) && expired ? (
                    <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                      {isRecipient ? 'expired — ask the payer to claim it back' : 'expired'}
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>
                      {isRecipient ? 'waiting for you to accept' : 'waiting for recipient'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Receiver claims (sender escrows → recipient claims) */}
      {ENABLE_V1_RECEIVER_CLAIM && claims.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
          <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
            <SectionTitle>Receiver claims · escrow → claim</SectionTitle>
          </div>
          {[...claims].reverse().map((c, i) => (
            <div
              key={c.ref + i}
              style={{
                display: 'grid',
                gridTemplateColumns: '0.8fr 1fr 1.4fr 1.8fr',
                gap: 14,
                alignItems: 'center',
                padding: '12px 22px',
                borderBottom: i === claims.length - 1 ? 'none' : '1px solid var(--line)',
              }}
            >
              <span className="badge" style={{ fontSize: 11, justifySelf: 'start' }}>
                {c.ref.split(':').pop()}
              </span>
              <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>{fmtCC(c.amount, unit)}</span>
              <div>
                <span
                  className="badge"
                  style={{
                    fontSize: 11,
                    color: c.status === 'claimed' ? 'var(--accent)' : 'var(--fg-2)',
                  }}
                >
                  {claimStatusLabel(c.status)}
                </span>
                <span style={{ display: 'block', fontSize: 10.5, color: 'var(--fg-4)', marginTop: 4 }}>
                  unlocks {fmt(c.unlockAt)}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                {isVerifiableUpdateId(c.claimUpdateId) ? (
                  <a
                    href={explorerUpdateUrl(c.claimUpdateId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: 'var(--accent)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'block',
                    }}
                    title={c.claimUpdateId}
                  >
                    claimed · {c.claimUpdateId} ↗
                  </a>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--fg-4)' }}>
                    {c.status === 'allocated'
                      ? 'awaiting sender setup'
                      : c.status === 'claim_ready'
                        ? 'ready for recipient to claim'
                        : c.status}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Settled-cycle history */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
          <SectionTitle>Settled cycles</SectionTitle>
        </div>
        {state.history.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--fg-3)', fontSize: 12.5 }}>
            <Clock size={18} style={{ color: 'var(--fg-4)', marginBottom: 6 }} />
            <div>
              {isPayer
                ? 'No cycles settled yet. Press “Settle now” to draw the first cycle.'
                : 'No cycles settled yet. The payer settles on demand.'}
            </div>
          </div>
        ) : (
          [...state.history].reverse().map((h, i) => (
            <div
              key={h.ref + i}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1.6fr',
                gap: 14,
                alignItems: 'center',
                padding: '12px 22px',
                borderBottom: i === state.history.length - 1 ? 'none' : '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="badge accent" style={{ fontSize: 11 }}>
                  <Check size={11} /> {h.ref.split(':').pop()}
                </span>
                {h.verified && (
                  <span
                    className="badge"
                    title="This cycle was recorded against a transfer object your wallet fetched and the proxy validated — a wallet-side proof of delivery."
                    style={{ fontSize: 10.5, color: 'var(--accent)' }}
                  >
                    <ShieldCheck size={11} style={{ marginRight: 3 }} /> verified transfer
                  </span>
                )}
              </div>
              <div className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
                {fmtCC(h.amount, unit)}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>{fmt(h.at)}</div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: 'var(--fg-4)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={h.updateId}
                >
                  {isVerifiableUpdateId(h.updateId) ? (
                    <a
                      href={explorerUpdateUrl(h.updateId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent)', textDecoration: 'none' }}
                    >
                      update {h.updateId} ↗
                    </a>
                  ) : (
                    <span style={{ color: 'var(--warn)' }}>
                      update {h.updateId} (unverified)
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SettleBanner({
  result,
  rate,
  unit,
}: {
  readonly result: V1SettleResult;
  readonly rate: string;
  readonly unit: string;
}) {
  // A transfer that landed as a pending offer (recipient has no pre-approval):
  // the CC is locked on-ledger, NOT delivered, until the recipient accepts. Show
  // this as an amber "sent, awaiting acceptance" state — never a green settle.
  if (result.pending) {
    const p = result.pending;
    return (
      <div
        className="card"
        style={{
          padding: 14,
          marginBottom: 18,
          fontSize: 12.5,
          color: 'var(--fg-2)',
          borderColor: 'color-mix(in oklab, var(--warn) 45%, var(--line))',
          lineHeight: 1.5,
        }}
      >
        <Send size={14} style={{ color: 'var(--warn)', marginRight: 6, verticalAlign: 'middle' }} />
        <strong style={{ color: 'var(--fg)' }}>Offer sent for {fmtCC(p.amount, unit)}</strong> — the recipient
        has no pre-approval, so the CC is locked on-ledger and waits for them to <strong>Accept</strong>{' '}
        it in their wallet (or you can withdraw/retry after {fmt(p.executeBefore)}).
        {isVerifiableUpdateId(p.createUpdateId) && (
          <div style={{ marginTop: 6 }}>
            <a
              href={explorerUpdateUrl(p.createUpdateId)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', textDecoration: 'none', fontSize: 11.5 }}
            >
              View the offer on {explorerName()} <ExternalLink size={11} />
            </a>
          </div>
        )}
      </div>
    );
  }
  if (!result.settled) {
    return (
      <div
        className="card"
        style={{ padding: 14, marginBottom: 18, fontSize: 12.5, color: 'var(--fg-2)' }}
      >
        <Clock size={13} style={{ color: 'var(--warn)', marginRight: 6, verticalAlign: 'middle' }} />
        Nothing has accrued this cycle{result.reason ? ` (${result.reason})` : ''}. Toggle{' '}
        “Settle one cycle now” to draw one {fmtCC(rate, unit)} cycle immediately (spends real funds).
      </div>
    );
  }
  // A `settled` result is only believable with a real, Scan-verifiable update id.
  // Without one we refuse to paint a green "settled" banner (this is the same
  // gate `onSettle` applies — kept here as defence in depth).
  if (!isVerifiableUpdateId(result.updateId)) {
    return (
      <div
        className="card"
        style={{
          padding: 14,
          marginBottom: 18,
          fontSize: 12.5,
          color: 'var(--danger)',
          borderColor: 'var(--danger)',
          lineHeight: 1.5,
        }}
      >
        <strong>Not confirmed on chain</strong>
        <div style={{ marginTop: 4, color: 'var(--fg-2)' }}>
          The settle returned no verifiable on-ledger transaction id, so nothing should be
          treated as paid. Retry, and approve the wallet signature prompt.
        </div>
      </div>
    );
  }
  return (
    <div
      className="card"
      style={{
        padding: 14,
        marginBottom: 18,
        fontSize: 12.5,
        color: 'var(--fg-2)',
        borderColor: 'color-mix(in oklab, var(--accent) 45%, var(--line))',
        background: 'var(--accent-soft)',
      }}
    >
      <Check size={14} style={{ color: 'var(--accent)', marginRight: 6, verticalAlign: 'middle' }} />
      Settled cycle {result.cycle} for{' '}
      <span className="mono">{result.amount ? fmtCC(result.amount, unit) : '—'}</span> · confirmed on chain.
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--fg-4)' }}>update</span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--fg-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 300,
            whiteSpace: 'nowrap',
          }}
          title={result.updateId}
        >
          {result.updateId}
        </span>
        <a
          href={explorerUpdateUrl(result.updateId)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: 'var(--accent)',
            textDecoration: 'none',
            fontSize: 11.5,
          }}
        >
          View on {explorerName()} <ExternalLink size={11} />
        </a>
      </div>
      {result.adminSynced === false && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--fg-4)' }}>
          On-ledger StreamAdmin projection not updated (observability only); the transfer above
          is confirmed.
        </div>
      )}
    </div>
  );
}

/**
 * Settle failure card. Recognises the "not enough CC" family of errors (the
 * proxy's `insufficient_funds` and the wallet-side empty/unreadable-balance
 * guards) and renders an actionable funding message with the live balance,
 * instead of dumping the raw "Settle failed: …" string.
 */
function SettleErrorCard({
  message,
  balance,
  unit = 'CC',
}: {
  readonly message: string;
  readonly balance: string | null;
  readonly unit?: string;
}) {
  const funding = /insufficient|holds 0 CC|fund (it|your)|not enough|could not be read/i.test(
    message,
  );
  return (
    <div
      className="card"
      style={{
        padding: 14,
        marginBottom: 18,
        borderColor: funding
          ? 'color-mix(in oklab, var(--warn) 50%, var(--line))'
          : 'var(--danger)',
        color: funding ? 'var(--fg-2)' : 'var(--danger)',
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: funding ? 'var(--warn)' : 'var(--danger)' }}>
        {funding ? 'Not enough CC to settle' : 'Settle failed'}
      </strong>
      <div style={{ marginTop: 4 }}>{message}</div>
      {funding && (
        <div style={{ marginTop: 6, color: 'var(--fg-4)' }}>
          {balance !== null ? `Your wallet holds ${fmtCC(balance, unit)}. ` : ''}
          Top up your wallet with {unit}, then press Settle again.
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  mono,
  accent,
}: {
  readonly label: string;
  readonly value: string;
  readonly suffix?: string;
  readonly mono?: boolean;
  readonly accent?: boolean;
}) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 10.5, color: 'var(--fg-4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div
        className={mono ? 'mono' : undefined}
        style={{
          fontSize: 18,
          fontWeight: 500,
          marginTop: 4,
          color: accent ? 'var(--accent)' : 'var(--fg)',
        }}
      >
        {value}
        {suffix ? (
          <span style={{ fontSize: 12, color: 'var(--fg-4)', marginLeft: 4 }}>{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Human label for a pending-offer record's lifecycle status. */
function pendingStatusLabel(status: V1PendingTransferRecord['status']): string {
  switch (status) {
    case 'pending':
      return 'Awaiting acceptance';
    case 'accepted':
      return 'Accepted';
    case 'withdrawn':
      return 'Reclaimed';
    case 'expired':
      return 'Expired — reclaimable';
    default:
      return status;
  }
}

/** Human label for a receiver-claim record's lifecycle status. */
function claimStatusLabel(status: V1ReceiverClaimRecord['status']): string {
  switch (status) {
    case 'allocated':
      return 'Escrowed';
    case 'claim_ready':
      return 'Claimable';
    case 'claimed':
      return 'Claimed';
    case 'withdrawn':
      return 'Reclaimed';
    default:
      return status;
  }
}

/** Format a decimal-string amount as "<value> <unit>", trimming trailing zeros.
 *  `unit` defaults to CC; a non-CC stream passes its instrument id instead.
 *  Non-numeric input is passed through with the suffix so we never hide data. */
function fmtCC(raw: string, unit = 'CC'): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  // Trim to a sane number of places without forcing trailing zeros.
  const trimmed = n.toLocaleString(undefined, { maximumFractionDigits: 10 });
  return `${trimmed} ${unit}`;
}

/** The display unit for a V1 stream's asset — CC unless it's a non-CC asset. */
function streamUnit(agreement: V1Agreement): string {
  const key = agreement.assetKey?.trim().toLowerCase();
  return !key || key === 'cc' ? 'CC' : agreement.instrument?.id || 'CC';
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--fg-3)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        padding: '8px 0',
        borderTop: '1px solid var(--line)',
        fontSize: 12.5,
      }}
    >
      <span style={{ color: 'var(--fg-3)' }}>{label}</span>
      <span style={{ color: 'var(--fg)', minWidth: 0, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function partyLine(p: string): ReactNode {
  return (
    <span title={p}>
      {p.split('::')[0]} <span className="mono" style={{ color: 'var(--fg-4)' }}>╱{partyShort(p)}</span>
    </span>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
