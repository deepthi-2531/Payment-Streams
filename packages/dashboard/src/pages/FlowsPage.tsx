/**
 * Open-ended flows page (StreamFlow — non-prefunded / rolling top-up).
 *
 * Minimal happy path: a zod-validated create form, the flows visible to
 * the connected party, and Top up / Withdraw / Stop actions. Humans
 * enter a rate in tokens per day; the on-ledger `flowRate` is tokens
 * per microsecond, converted on submit.
 */

import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import Decimal from 'decimal.js';
import { Waves } from 'lucide-react';
import { useAuth } from '../store/auth.js';
import {
  useFlows,
  useCreateFlow,
  useTopUpFlow,
  useWithdrawFlow,
  useStopFlow,
} from '../hooks/useFlows.js';
import type { RawFlow } from '../api/client.js';
import { Form } from '../components/forms/Form.js';
import { FormField } from '../components/forms/FormField.js';
import { AssetSelect } from '../components/streams/AssetSelect.js';
import { formatCantonDateTime } from '../lib/cantonTime.js';
import {
  createFlowSchema,
  type CreateFlowSchemaValues,
} from '../lib/schemas/createFlow.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
  SectionHeader,
  Modal,
} from '../components/common/index.js';

const MICROS_PER_DAY = new Decimal(86_400_000_000);

const inputClass =
  'block w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:ring-1 focus:ring-brand-500 transition-colors';

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--fg)',
  outline: 'none',
};

export function FlowsPage() {
  const auth = useAuth();
  const party = auth.party ?? '';
  // Flows put a canton-streams contract on the payer's participant, so they only
  // work where that participant vets our DAR. Gate on the same signal the
  // custody create uses; skip the (canton-streams) reads otherwise.
  const canFlow = auth.canCreateCustodyStream;

  // Two directional queries: flows I send and flows I receive. The proxy
  // pins unfiltered queries to recipient-scope, so ask for both explicitly.
  const outgoing = useFlows(party && canFlow ? { sender: party } : undefined);
  const incoming = useFlows(party && canFlow ? { recipient: party } : undefined);

  if (!party) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader
          title="Open-ended Flows"
          subtitle="Non-prefunded streams with a per-day rate and a rolling funded balance"
        />
        <div
          className="card"
          style={{ padding: 36, textAlign: 'center', color: 'var(--fg-3)' }}
        >
          Connect to a Canton participant to view flows.
        </div>
      </div>
    );
  }

  if (!canFlow) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader
          title="Open-ended Flows"
          subtitle="Non-prefunded streams with a per-day rate and a rolling funded balance"
        />
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <Waves size={28} style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }} />
          <p style={{ margin: '0 0 6px', fontSize: 13.5, color: 'var(--fg)' }}>
            Flows aren&apos;t available for this wallet.
          </p>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-3)', maxWidth: 460, marginInline: 'auto' }}>
            A flow records a Canton Streams contract on your participant, which your
            wallet&apos;s network doesn&apos;t run. Use a{' '}
            <Link to="/v1/create" style={{ color: 'var(--accent)' }}>
              Direct delivery stream
            </Link>{' '}
            instead — it sends a token-standard transfer from your wallet each cycle,
            with nothing locked up front.
          </p>
        </div>
      </div>
    );
  }

  const flows = dedupeFlows([...(outgoing.data ?? []), ...(incoming.data ?? [])]);
  const isPending = outgoing.isPending || incoming.isPending;

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Open-ended Flows"
        subtitle="Non-prefunded streams with a per-day rate and a rolling funded balance"
      />

      <CreateFlowCard senderParty={party} />

      <SectionHeader title="Your flows" />

      {(outgoing.isError || incoming.isError) && (
        <ErrorState
          error={outgoing.error ?? incoming.error}
          title="Could not load flows"
          onRetry={() => {
            void outgoing.refetch();
            void incoming.refetch();
          }}
        />
      )}

      {isPending && <Skeleton.Row count={3} height={48} />}

      {!isPending && flows.length === 0 && (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <Waves size={28} style={{ color: 'var(--fg-5)', margin: '0 auto 8px' }} />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)' }}>
            No open-ended flows yet. Create one above.
          </p>
        </div>
      )}

      {flows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Flow</th>
                <th>Direction</th>
                <th>Rate / day</th>
                <th>Funded</th>
                <th>Withdrawn</th>
                <th>Started</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {flows.map((flow) => (
                <FlowRow key={flow.contractId} flow={flow} party={party} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function dedupeFlows(flows: RawFlow[]): RawFlow[] {
  const seen = new Set<string>();
  return flows.filter((f) => {
    if (seen.has(f.contractId)) return false;
    seen.add(f.contractId);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function CreateFlowCard({ senderParty }: { readonly senderParty: string }) {
  const createFlow = useCreateFlow();

  const onSubmit = (values: CreateFlowSchemaValues) => {
    createFlow.mutate({
      sender: senderParty,
      recipient: values.recipient,
      escrowOperator: values.escrowOperator,
      instrumentRef: {
        depository: values.instrumentAdmin,
        issuer: values.instrumentAdmin,
        instrumentId: values.instrumentId,
        instrumentVersion: 'v2',
      },
      // On-ledger rate is tokens per microsecond at Numeric 10 scale.
      flowRate: new Decimal(values.ratePerDay).div(MICROS_PER_DAY).toFixed(20),
      fundedAmount: values.initialFunding,
    });
  };

  return (
    <div className="card" style={{ padding: 20, marginBottom: 24 }}>
      <SectionHeader title="Start a flow" />
      <Form<CreateFlowSchemaValues>
        schema={createFlowSchema}
        defaultValues={{ initialFunding: '0' }}
        onSubmit={onSubmit}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <FormField name="recipient" label="Recipient party" required>
            <input className={inputClass} style={inputStyle} placeholder="alice::1220abcd…" />
          </FormField>
          <FormField name="escrowOperator" label="Escrow operator party" required>
            <input className={inputClass} style={inputStyle} placeholder="operator::1220abcd…" />
          </FormField>
          <div style={{ gridColumn: '1 / -1' }}>
            <AssetSelect />
          </div>
          <FormField
            name="ratePerDay"
            label="Rate (tokens / day)"
            required
            help="Stored on-ledger as tokens per microsecond at 10 decimal places."
          >
            <input className={inputClass} style={inputStyle} placeholder="100" />
          </FormField>
          <FormField
            name="initialFunding"
            label="Initial funding"
            help="Funded balance to start with; top up any time."
          >
            <input className={inputClass} style={inputStyle} placeholder="0" />
          </FormField>
        </div>

        {createFlow.isError && (
          <p style={{ fontSize: 12, color: 'var(--danger)', margin: '6px 0' }}>
            {(createFlow.error as Error).message}
          </p>
        )}
        {createFlow.isSuccess && (
          <p style={{ fontSize: 12, color: 'var(--accent)', margin: '6px 0' }}>
            Flow created — id {createFlow.data.streamId}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={createFlow.isPending}>
          {createFlow.isPending ? 'Creating…' : 'Create flow'}
        </button>
      </Form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row + actions
// ---------------------------------------------------------------------------

type FlowAction = 'top-up' | 'withdraw' | 'stop' | null;

function FlowRow({ flow, party }: { readonly flow: RawFlow; readonly party: string }) {
  const [action, setAction] = useState<FlowAction>(null);

  const isSender = flow.sender === party;
  const isRecipient = flow.recipient === party;
  const ratePerDay = new Decimal(flow.flowRate).times(MICROS_PER_DAY);
  const truncate = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
  const stopped = flow.status === 'FlowStopped';

  return (
    <tr>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {truncate(flow.streamId)}
      </td>
      <td style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {isSender ? `→ ${flow.recipient.split('::')[0]}` : `← ${flow.sender.split('::')[0]}`}
      </td>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {ratePerDay.toSignificantDigits(6).toString()}
      </td>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {new Decimal(flow.fundedAmount).toFixed(4)}
      </td>
      <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        {new Decimal(flow.totalWithdrawn).toFixed(4)}
      </td>
      <td className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
        {formatCantonDateTime(flow.startTime)}
      </td>
      <td>
        <span
          className={`badge ${flow.status === 'FlowActive' ? 'info' : ''}`}
          style={{ fontSize: 10 }}
        >
          {flow.status.replace('Flow', '')}
        </span>
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {!stopped && isSender && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setAction('top-up')}>
            Top up
          </button>
        )}
        {!stopped && isRecipient && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setAction('withdraw')}>
            Withdraw
          </button>
        )}
        {!stopped && (isSender || isRecipient) && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setAction('stop')}>
            Stop
          </button>
        )}
        {action === 'top-up' && <TopUpModal flow={flow} onClose={() => setAction(null)} />}
        {action === 'withdraw' && <WithdrawModal flow={flow} onClose={() => setAction(null)} />}
        {action === 'stop' && <StopModal flow={flow} onClose={() => setAction(null)} />}
      </td>
    </tr>
  );
}

function TopUpModal({ flow, onClose }: { readonly flow: RawFlow; readonly onClose: () => void }) {
  const topUp = useTopUpFlow();
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const valid = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0 && reference.trim() !== '';

  const submit = () => {
    topUp.mutate(
      {
        sender: flow.sender,
        flowId: flow.streamId,
        topUpAmount: amount,
        settlementReference: reference.trim(),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Top up flow"
      subtitle="Adds to the funded balance the recipient can draw from."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || topUp.isPending} onClick={submit}>
            {topUp.isPending ? 'Submitting…' : 'Top up'}
          </button>
        </>
      }
    >
      <label style={fieldLabelStyle}>Amount</label>
      <input
        className={inputClass}
        style={inputStyle}
        placeholder="100"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label style={fieldLabelStyle}>Settlement reference</label>
      <input
        className={inputClass}
        style={inputStyle}
        placeholder="external transfer reference"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      {topUp.isError && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
          {(topUp.error as Error).message}
        </p>
      )}
    </Modal>
  );
}

function WithdrawModal({ flow, onClose }: { readonly flow: RawFlow; readonly onClose: () => void }) {
  const withdraw = useWithdrawFlow();
  const [reference, setReference] = useState('');
  const valid = reference.trim() !== '';

  const submit = () => {
    withdraw.mutate(
      { sender: flow.sender, flowId: flow.streamId, settlementReference: reference.trim() },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Withdraw accrued"
      subtitle="Claims everything accrued so far, bounded by the funded balance."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid || withdraw.isPending}
            onClick={submit}
          >
            {withdraw.isPending ? 'Submitting…' : 'Withdraw'}
          </button>
        </>
      }
    >
      <label style={fieldLabelStyle}>Settlement reference</label>
      <input
        className={inputClass}
        style={inputStyle}
        placeholder="external transfer reference"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      {withdraw.isError && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
          {(withdraw.error as Error).message}
        </p>
      )}
    </Modal>
  );
}

function StopModal({ flow, onClose }: { readonly flow: RawFlow; readonly onClose: () => void }) {
  const stop = useStopFlow();
  // The contract asserts the split matches its own accrual at stopTime,
  // so compute both legs the same way (Numeric 10, HALF_EVEN) and submit
  // the stopTime the computation used.
  const [computed] = useState(() => {
    const stopTime = new Date(Date.now() - 1_000);
    const elapsedMicros = computeElapsedMicros(flow, stopTime);
    const accrued = new Decimal(flow.flowRate)
      .times(elapsedMicros.toString())
      .toDecimalPlaces(10, Decimal.ROUND_HALF_EVEN);
    const funded = new Decimal(flow.fundedAmount);
    const withdrawn = new Decimal(flow.totalWithdrawn);
    const owed = Decimal.max(0, Decimal.min(accrued, funded).minus(withdrawn));
    const refund = Decimal.max(0, funded.minus(withdrawn).minus(owed));
    return { stopTime, owed, refund };
  });
  const [reference, setReference] = useState('');

  const submit = () => {
    stop.mutate(
      {
        sender: flow.sender,
        flowId: flow.streamId,
        recipientSettlement: computed.owed.toFixed(10),
        senderRefund: computed.refund.toFixed(10),
        ...(reference.trim() ? { recipientSettlementReference: reference.trim() } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Stop flow"
      subtitle="Mutual termination: accrued goes to the recipient, the rest refunds the sender."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={stop.isPending} onClick={submit}>
            {stop.isPending ? 'Submitting…' : 'Stop flow'}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Recipient settlement</span>
          <span className="mono">{computed.owed.toFixed(4)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Sender refund</span>
          <span className="mono">{computed.refund.toFixed(4)}</span>
        </div>
      </div>
      <label style={fieldLabelStyle}>Settlement reference (optional)</label>
      <input
        className={inputClass}
        style={inputStyle}
        placeholder="external transfer reference"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      {stop.isError && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
          {(stop.error as Error).message}
        </p>
      )}
    </Modal>
  );
}

/** Elapsed accrual-time in microseconds, excluding pauses (mirrors Daml). */
function computeElapsedMicros(flow: RawFlow, at: Date): bigint {
  const startMicros = BigInt(new Date(flow.startTime).getTime()) * 1000n;
  const atMicros = BigInt(at.getTime()) * 1000n;
  const pausedMicros = BigInt(Math.trunc(flow.cumulativePausedMicros ?? 0));
  const currentPauseMicros =
    flow.status === 'FlowPaused' && flow.pausedAt
      ? atMicros - BigInt(new Date(flow.pausedAt).getTime()) * 1000n
      : 0n;
  const elapsed = atMicros - startMicros - pausedMicros - currentPauseMicros;
  return elapsed > 0n ? elapsed : 0n;
}

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--fg-2)',
  margin: '10px 0 4px',
};
