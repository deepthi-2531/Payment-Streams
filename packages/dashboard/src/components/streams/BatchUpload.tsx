/**
 * BatchUpload — STR-117 Phase 6.
 *
 * Drop-CSV → parse with papaparse → zod-validate every row → preview
 * → fan-out N `useCreateStream` mutations with per-row progress.
 *
 * The proxy does not (yet) expose a `/streams/batch` endpoint, so the
 * page issues N parallel-but-bounded create commands and aggregates
 * status row-by-row. When that endpoint lands, swap the per-row call
 * for a single batched mutation — the UI doesn't need to change.
 *
 * Every row is V2 token-standard explicit: the CSV must carry the
 * funding reference, Amulet account refs, escrow operator, and V2
 * instrument admin. We do not fall back to legacy/sandbox settlement.
 */

import { useMemo, useRef, useState, type CSSProperties } from 'react';
import Papa from 'papaparse';
import Decimal from 'decimal.js';
import { AlertTriangle, Check, CheckCircle2, FileText, Loader2, Upload, X } from 'lucide-react';
import {
  AssetType,
  SettlementMode,
  VestingMode,
  type CreateStreamParams,
} from '@canton-streams/sdk/browser';
import { useCreateStream } from '../../hooks/useStreams.js';
import { useAuth } from '../../store/auth.js';
import { batchRowSchema, type BatchRow } from '../../lib/schemas/index.js';

interface ParsedRow {
  readonly index: number;
  readonly raw: Record<string, string>;
  readonly value: BatchRow | null;
  readonly error: string | null;
}

interface SubmitResult {
  readonly status: 'pending' | 'success' | 'error';
  readonly message?: string;
  readonly streamId?: string;
}

// Per-variant columns at the right edge — cliffTime / stepInterval /
// amountPerStep / termDuration. Leave them empty on Linear rows; supply
// them as required by the vesting mode on the other rows. The zod
// schema enforces this so you get a useful per-cell error in the
// preview rather than a silent default like "1 day in microseconds".
const SAMPLE_CSV = `recipient,amount,asset,instrumentAdmin,fundingReference,senderAccount,recipientAccount,escrowOperator,start,end,vesting,cancellable,cliffTime,stepInterval,amountPerStep,termDuration
bob::1220abcd,8000,CC,amulet::1220admin,allocation-bob-001,"{""owner"":""alice::1220sender"",""id"":""default""}","{""owner"":""bob::1220abcd"",""id"":""default""}",operator::1220escrow,2026-01-01T00:00,2026-12-31T00:00,Linear,true,,,,
carol::1220beef,120000,CC,amulet::1220admin,allocation-carol-001,"{""owner"":""alice::1220sender"",""id"":""default""}","{""owner"":""carol::1220beef"",""id"":""default""}",operator::1220escrow,2026-01-01T00:00,2030-01-01T00:00,CliffLinear,false,2027-01-01T00:00,,,
erin::1220cafe,12,CC,amulet::1220admin,allocation-erin-001,"{""owner"":""alice::1220sender"",""id"":""default""}","{""owner"":""erin::1220cafe"",""id"":""default""}",operator::1220escrow,2026-01-01T00:00,2026-04-01T00:00,Stepped,true,,86400000000,1,
frank::1220feed,300,CC,amulet::1220admin,allocation-frank-001,"{""owner"":""alice::1220sender"",""id"":""default""}","{""owner"":""frank::1220feed"",""id"":""default""}",operator::1220escrow,2026-01-01T00:00,2026-12-31T00:00,RenewableTerm,true,,,,2592000000000
`;

const MAX_ROWS = 500;
const MAX_PARALLEL = 4;

export function BatchUpload() {
  const { party } = useAuth();
  const createStream = useCreateStream();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [results, setResults] = useState<Record<number, SubmitResult>>({});
  const [submitting, setSubmitting] = useState(false);

  const stats = useMemo(() => {
    const valid = rows.filter((r) => r.value !== null);
    const totalAmount = valid.reduce((sum, r) => sum + Number(r.value?.amount ?? 0), 0);
    const assets = new Set(valid.map((r) => r.value!.asset));
    const recipients = new Set(valid.map((r) => r.value!.recipient));
    return {
      total: rows.length,
      valid: valid.length,
      invalid: rows.length - valid.length,
      totalAmount,
      assets: assets.size,
      recipients: recipients.size,
    };
  }, [rows]);

  const submittedCount = useMemo(
    () => Object.values(results).filter((r) => r.status !== 'pending').length,
    [results],
  );

  // ------------------------------------------------------------------
  // CSV parsing
  // ------------------------------------------------------------------

  const handleFile = (file: File) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (parsed) => {
        const incoming = parsed.data.slice(0, MAX_ROWS).map((raw, i) => validateRow(raw, i));
        setRows(incoming);
        setResults({});
        setStep('preview');
      },
    });
  };

  const loadSample = () => {
    const parsed = Papa.parse<Record<string, string>>(SAMPLE_CSV.trim(), {
      header: true,
      skipEmptyLines: true,
    });
    const incoming = parsed.data.map((raw, i) => validateRow(raw, i));
    setRows(incoming);
    setResults({});
    setStep('preview');
  };

  // ------------------------------------------------------------------
  // Fan-out submit
  // ------------------------------------------------------------------

  const handleSubmit = async () => {
    if (!party) return;
    setSubmitting(true);
    const valid = rows.filter((r) => r.value !== null);
    const initial: Record<number, SubmitResult> = {};
    valid.forEach((r) => {
      initial[r.index] = { status: 'pending' };
    });
    setResults(initial);

    // Bounded parallelism via a sliding window. Avoids N tasks landing
    // simultaneously on the proxy while still beating strict-serial.
    const queue = valid.slice();
    const workers: Promise<void>[] = [];
    for (let w = 0; w < MAX_PARALLEL; w++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const row = queue.shift();
            if (!row) break;
            try {
              const params = buildCreateParams(party, row.value!);
              const r = await createStream.mutateAsync(params);
              setResults((prev) => ({
                ...prev,
                [row.index]: {
                  status: 'success',
                  streamId: r.streamId,
                },
              }));
            } catch (err) {
              setResults((prev) => ({
                ...prev,
                [row.index]: {
                  status: 'error',
                  message: err instanceof Error ? err.message : 'Failed to create',
                },
              }));
            }
          }
        })(),
      );
    }

    await Promise.all(workers);
    setSubmitting(false);
    setStep('done');
  };

  const reset = () => {
    setStep('upload');
    setRows([]);
    setResults({});
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (step === 'upload') {
    return <UploadStep onFile={handleFile} onSample={loadSample} fileInputRef={fileInputRef} />;
  }

  if (step === 'preview') {
    return (
      <PreviewStep
        rows={rows}
        stats={stats}
        submitting={submitting}
        submittedCount={submittedCount}
        canSubmit={stats.valid > 0 && !!party}
        onReplace={reset}
        onSubmit={handleSubmit}
        results={results}
      />
    );
  }

  return <DoneStep rows={rows} results={results} onAnother={reset} />;
}

// ---------------------------------------------------------------------------
// Step 1: Upload
// ---------------------------------------------------------------------------

function UploadStep({
  onFile,
  onSample,
  fileInputRef,
}: {
  readonly onFile: (file: File) => void;
  readonly onSample: () => void;
  readonly fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="card" style={{ padding: 36 }}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).style.borderColor =
            'var(--accent-line, var(--line-2))';
        }}
        onDragLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--line-2)';
        }}
        onDrop={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--line-2)';
          if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
        }}
        style={dropZoneStyle}
      >
        <div style={dropIconStyle}>
          <Upload size={22} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>Drop your CSV here</div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginBottom: 18 }}>
          or click below to browse · max {MAX_ROWS} rows per batch
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={13} /> Choose CSV
          </button>
          <button type="button" className="btn btn-secondary" onClick={onSample}>
            Try sample data
          </button>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: 'var(--fg-4)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 10,
          }}
        >
          CSV format
        </div>
        <pre
          className="mono"
          style={{
            padding: 14,
            background: 'var(--bg-elev)',
            borderRadius: 8,
            fontSize: 11.5,
            color: 'var(--fg-2)',
            overflow: 'auto',
            border: '1px solid var(--line)',
            margin: 0,
          }}
        >
          {SAMPLE_CSV}
        </pre>
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--fg-4)',
            marginTop: 10,
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              recipient
            </span>{' '}
            — party id including <code>::</code>
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              amount
            </span>{' '}
            — positive decimal
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              asset
            </span>{' '}
            — V2 instrument id (CC / USDCx / …)
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              instrumentAdmin
            </span>{' '}
            — V2 instrument admin party
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              fundingReference
            </span>{' '}
            — Amulet allocation/funding reference
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              senderAccount
            </span>{' '}
            /{' '}
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              recipientAccount
            </span>{' '}
            — JSON account refs
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              start
            </span>{' '}
            /{' '}
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              end
            </span>{' '}
            — ISO datetime
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              vesting
            </span>{' '}
            — Linear / CliffLinear / Stepped / RenewableTerm
          </span>
          <span>
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              cancellable
            </span>{' '}
            — true / false
          </span>
        </div>
        <div
          style={{
            marginTop: 18,
            padding: 12,
            background: 'color-mix(in oklab, var(--warn) 6%, var(--bg-elev))',
            border: '1px solid color-mix(in oklab, var(--warn) 25%, var(--line))',
            borderRadius: 8,
            fontSize: 11.5,
            color: 'var(--fg-2)',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={14} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
          <span>
            Batch uploads are V2-only. Prepare funding/allocation refs with the Amulet wallet first;
            rows missing token-standard account or funding fields are rejected instead of falling
            back to legacy settlement.
          </span>
        </div>
      </div>
    </div>
  );
}

const dropZoneStyle: CSSProperties = {
  border: '1.5px dashed var(--line-2)',
  borderRadius: 14,
  padding: 60,
  textAlign: 'center',
  background: 'var(--bg-elev)',
  transition: 'border-color 120ms',
};

const dropIconStyle: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 14,
  background: 'color-mix(in oklab, var(--accent) 12%, var(--card))',
  border: '1px solid var(--accent-line, var(--line-2))',
  margin: '0 auto 18px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--accent)',
};

// ---------------------------------------------------------------------------
// Step 2: Preview
// ---------------------------------------------------------------------------

interface PreviewStats {
  total: number;
  valid: number;
  invalid: number;
  totalAmount: number;
  assets: number;
  recipients: number;
}

function PreviewStep({
  rows,
  stats,
  submitting,
  submittedCount,
  canSubmit,
  onReplace,
  onSubmit,
  results,
}: {
  readonly rows: ParsedRow[];
  readonly stats: PreviewStats;
  readonly submitting: boolean;
  readonly submittedCount: number;
  readonly canSubmit: boolean;
  readonly onReplace: () => void;
  readonly onSubmit: () => void;
  readonly results: Record<number, SubmitResult>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 500,
              color: 'var(--fg)',
            }}
          >
            Preview · {stats.total} rows
          </h2>
          <p
            style={{
              fontSize: 12,
              color: 'var(--fg-4)',
              margin: '4px 0 0',
            }}
          >
            <span className="mono" style={{ color: 'var(--accent)' }}>
              {stats.valid} valid
            </span>{' '}
            ·{' '}
            <span
              className="mono"
              style={{
                color: stats.invalid > 0 ? 'var(--danger)' : 'var(--fg-3)',
              }}
            >
              {stats.invalid} invalid
            </span>{' '}
            · total{' '}
            <span className="mono" style={{ color: 'var(--fg-2)' }}>
              {stats.totalAmount.toLocaleString()}
            </span>{' '}
            across {stats.assets} asset(s) · {stats.recipients} recipient(s)
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onReplace}
            disabled={submitting}
          >
            Replace file
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? (
              <>
                <Loader2 size={13} style={{ animation: 'spin 800ms linear infinite' }} /> Signing{' '}
                {submittedCount}/{stats.valid}…
              </>
            ) : (
              <>
                <Check size={13} /> Sign & propose {stats.valid}
              </>
            )}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>#</th>
              <th>Recipient</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th>Asset</th>
              <th>Schedule</th>
              <th>Vesting</th>
              <th>Cancel</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <PreviewRow key={r.index} row={r} result={results[r.index]} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewRow({
  row,
  result,
}: {
  readonly row: ParsedRow;
  readonly result: SubmitResult | undefined;
}) {
  const r = row.value;
  return (
    <tr
      style={{
        background:
          row.error !== null ? 'color-mix(in oklab, var(--danger) 4%, transparent)' : 'transparent',
      }}
    >
      <td className="mono" style={{ fontSize: 11.5, color: 'var(--fg-4)' }}>
        {row.index + 1}
      </td>
      <td
        className="mono"
        style={{
          fontSize: 12,
          color: row.error ? 'var(--danger)' : 'var(--fg-2)',
          maxWidth: 200,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={r?.recipient ?? row.raw.recipient ?? '—'}
      >
        {shortenParty(r?.recipient ?? row.raw.recipient ?? '—')}
      </td>
      <td className="mono" style={{ textAlign: 'right', fontSize: 12 }}>
        {r?.amount ?? row.raw.amount ?? '—'}
      </td>
      <td className="mono" style={{ fontSize: 12 }}>
        {r?.asset ?? row.raw.asset ?? '—'}
      </td>
      <td className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        {r ? `${shortDate(r.start)} → ${shortDate(r.end)}` : '—'}
      </td>
      <td>
        <span className="badge muted" style={{ fontSize: 10.5 }}>
          {r?.vesting ?? row.raw.vesting ?? '—'}
        </span>
      </td>
      <td style={{ fontSize: 12, color: 'var(--fg-3)' }}>
        {r ? (r.cancellable ? 'Yes' : 'No') : (row.raw.cancellable ?? '—')}
      </td>
      <td style={{ textAlign: 'right', fontSize: 11.5 }}>
        <StatusCell error={row.error} result={result} />
      </td>
    </tr>
  );
}

function StatusCell({
  error,
  result,
}: {
  readonly error: string | null;
  readonly result: SubmitResult | undefined;
}) {
  if (error) {
    return (
      <span
        title={error}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: 'var(--danger)',
        }}
      >
        <X size={11} /> {truncate(error, 24)}
      </span>
    );
  }
  if (!result) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: 'var(--accent)',
        }}
      >
        <Check size={11} /> OK
      </span>
    );
  }
  if (result.status === 'pending') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: 'var(--fg-3)',
        }}
      >
        <Loader2 size={11} style={{ animation: 'spin 800ms linear infinite' }} /> Signing
      </span>
    );
  }
  if (result.status === 'success') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: 'var(--accent)',
        }}
      >
        <CheckCircle2 size={11} /> Proposed
      </span>
    );
  }
  return (
    <span
      title={result.message}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: 'var(--danger)',
      }}
    >
      <X size={11} /> {truncate(result.message ?? 'Failed', 24)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Done
// ---------------------------------------------------------------------------

function DoneStep({
  rows,
  results,
  onAnother,
}: {
  readonly rows: ParsedRow[];
  readonly results: Record<number, SubmitResult>;
  readonly onAnother: () => void;
}) {
  const success = Object.values(results).filter((r) => r.status === 'success').length;
  const failed = Object.values(results).filter((r) => r.status === 'error').length;

  return (
    <div
      className="card"
      style={{ padding: 36, display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background:
              failed > 0 ? 'color-mix(in oklab, var(--warn) 30%, var(--card))' : 'var(--accent)',
            color: '#06090d',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {failed > 0 ? <AlertTriangle size={22} /> : <Check size={24} />}
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--fg)' }}>
            {failed === 0 ? 'Batch submitted' : 'Batch partially submitted'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 4 }}>
            <span className="mono" style={{ color: 'var(--accent)' }}>
              {success}
            </span>{' '}
            proposed ·{' '}
            <span
              className="mono"
              style={{
                color: failed > 0 ? 'var(--danger)' : 'var(--fg-3)',
              }}
            >
              {failed}
            </span>{' '}
            failed
          </div>
        </div>
      </div>

      {failed > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--line)',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--fg-4)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Failures
          </div>
          {rows
            .filter((r) => results[r.index]?.status === 'error')
            .map((r) => (
              <div
                key={r.index}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--line)',
                  fontSize: 12,
                  color: 'var(--fg-2)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                }}
              >
                <FileText
                  size={12}
                  style={{
                    color: 'var(--danger)',
                    marginTop: 2,
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ color: 'var(--fg)', fontWeight: 500 }}>
                    Row {r.index + 1}: {shortenParty(r.value?.recipient ?? r.raw.recipient ?? '—')}
                  </div>
                  <div style={{ color: 'var(--danger)', marginTop: 2 }}>
                    {results[r.index]?.message}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}

      <div>
        <button type="button" className="btn btn-primary" onClick={onAnother}>
          Upload another batch
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateRow(raw: Record<string, string>, index: number): ParsedRow {
  const result = batchRowSchema.safeParse(raw);
  if (result.success) {
    return { index, raw, value: result.data, error: null };
  }
  const firstError = result.error.issues[0];
  if (!firstError) {
    return { index, raw, value: null, error: 'Invalid row' };
  }
  const path = firstError.path.length ? firstError.path.join('.') + ': ' : '';
  return {
    index,
    raw,
    value: null,
    error: `${path}${firstError.message}`,
  };
}

function buildCreateParams(party: string, row: BatchRow): CreateStreamParams {
  // The CSV schema (lib/schemas/batchRow.ts) now requires per-variant
  // columns for CliffLinear / Stepped / RenewableTerm. Reading them
  // straight off `row` keeps the buildParams call honest — earlier
  // revisions hard-coded 1-day step intervals and 30-day terms, which
  // silently shipped wrong vesting curves whenever the CSV asked for
  // non-Linear modes.
  const vestingConfig =
    row.vesting === VestingMode.Linear
      ? { mode: VestingMode.Linear as const }
      : row.vesting === VestingMode.CliffLinear
        ? {
            mode: VestingMode.CliffLinear as const,
            // Schema guarantees cliffTime is present for this branch.
            cliffTime: new Date(row.cliffTime!),
          }
        : row.vesting === VestingMode.Stepped
          ? {
              mode: VestingMode.Stepped as const,
              // Schema guarantees both fields for this branch.
              stepInterval: row.stepInterval!,
              amountPerStep: new Decimal(row.amountPerStep!),
            }
          : {
              mode: VestingMode.RenewableTerm as const,
              // Schema guarantees termDuration for this branch.
              termDuration: row.termDuration!,
            };

  return {
    streamId: crypto.randomUUID(),
    sender: party,
    recipient: row.recipient,
    totalDeposited: new Decimal(row.amount),
    startTime: new Date(row.start),
    endTime: new Date(row.end),
    assetType: AssetType.GlobalCip56,
    settlementMode: SettlementMode.TokenStandardCustody,
    instrumentRef: {
      depository: row.instrumentAdmin,
      issuer: row.instrumentAdmin,
      instrumentId: row.asset,
      instrumentVersion: 'v2',
    },
    fundingReference: row.fundingReference,
    escrowOperator: row.escrowOperator,
    senderAccount: row.senderAccount,
    recipientAccount: row.recipientAccount,
    cancellable: row.cancellable,
    vestingMode: vestingConfig,
  } as CreateStreamParams;
}

function shortenParty(partyId: string): string {
  if (!partyId) return '—';
  if (partyId.length <= 18) return partyId;
  const sep = partyId.indexOf('::');
  if (sep <= 0) return partyId.slice(0, 10) + '…' + partyId.slice(-6);
  return partyId.slice(0, sep) + '::' + partyId.slice(sep + 2, sep + 8) + '…';
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
