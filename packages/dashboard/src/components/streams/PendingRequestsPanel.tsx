/**
 * PendingRequestsPanel.
 *
 * Reserved for the future V2 `StreamAdminRequest` propose/accept
 * template. The SDK currently creates `StreamAdmin` directly (no
 * intermediate request contract), so `usePendingStreamRequests`
 * always returns `[]` and this panel never renders — callers gate on
 * `requests.length > 0`.
 *
 * The panel + the underlying SDK query path are kept so the future
 * feature can plug back in without rebuilding the UI shell. If you are
 * implementing that feature, update the copy below ("Pending requests"
 * is fine, "Awaiting recipient acceptance" only becomes truthful once
 * the recipient genuinely has a dashboard accept step).
 */

import type { CSSProperties } from 'react';
import { Hourglass, CheckCircle2, ArrowRight } from 'lucide-react';
import type { PendingStreamRequest } from '@canton-streams/sdk/browser';
import { AssetType } from '@canton-streams/sdk/browser';
import { useAuth } from '../../store/auth.js';
import { useAcceptStream } from '../../hooks/useStreams.js';

export interface PendingRequestsPanelProps {
  readonly requests: PendingStreamRequest[];
}

function partyHint(partyId: string): string {
  const sep = partyId.indexOf('::');
  if (sep > 0) return partyId.slice(0, Math.min(sep, 20));
  return partyId.length > 20 ? partyId.slice(0, 16) + '…' : partyId;
}

const assetLabels: Record<string, string> = {
  [AssetType.ValidatorLocalAsset]: 'Local',
  [AssetType.LocalCip56]: 'CIP-56 Local',
  [AssetType.GlobalCip56]: 'CIP-56 Global',
};

const wrapperStyle: CSSProperties = {
  border: '1px solid color-mix(in oklab, var(--warn) 30%, var(--line))',
  background: 'color-mix(in oklab, var(--warn) 5%, var(--card))',
  borderRadius: 'var(--r-lg)',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '14px 18px',
  borderBottom: '1px solid color-mix(in oklab, var(--warn) 20%, var(--line))',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
  padding: '14px 18px',
  borderBottom: '1px solid color-mix(in oklab, var(--warn) 15%, var(--line))',
  flexWrap: 'wrap',
};

export function PendingRequestsPanel({ requests }: PendingRequestsPanelProps) {
  const { party } = useAuth();
  const accept = useAcceptStream();

  if (requests.length === 0) return null;

  return (
    <div style={wrapperStyle}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Hourglass size={14} style={{ color: 'var(--warn)' }} />
          <h3
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--fg)',
            }}
          >
            Pending requests
          </h3>
          <span
            className="badge warn"
            style={{ marginLeft: 'auto', fontSize: 10.5 }}
          >
            {requests.length}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--fg-4)' }}>
          Awaiting recipient acceptance.
        </p>
      </div>

      <div>
        {requests.map((request, i) => {
          const canAccept = party === request.config.recipient;
          const accepting =
            accept.isPending &&
            accept.variables?.sender === request.config.sender &&
            accept.variables?.streamId === request.config.streamId;
          const isLast = i === requests.length - 1;

          return (
            <div
              key={request.contractId}
              style={{
                ...rowStyle,
                borderBottom: isLast
                  ? 'none'
                  : '1px solid color-mix(in oklab, var(--warn) 15%, var(--line))',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: 'var(--fg)',
                    }}
                  >
                    {request.config.streamId.slice(0, 18)}
                    {request.config.streamId.length > 18 ? '…' : ''}
                  </span>
                  <span className="badge muted" style={{ fontSize: 10 }}>
                    {assetLabels[request.config.assetType] ??
                      request.config.assetType}
                  </span>
                  {request.config.instrumentRef && (
                    <span className="badge info" style={{ fontSize: 10 }}>
                      {request.config.instrumentRef.instrumentId}
                    </span>
                  )}
                  <span className="badge muted" style={{ fontSize: 10 }}>
                    {request.config.vestingMode.mode}
                  </span>
                </div>

                <div
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--fg-3)',
                    marginTop: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span title={request.config.sender}>
                    {partyHint(request.config.sender)}
                  </span>
                  <ArrowRight size={11} style={{ color: 'var(--fg-4)' }} />
                  <span title={request.config.recipient}>
                    {partyHint(request.config.recipient)}
                  </span>
                </div>

                <p
                  style={{
                    margin: '6px 0 0',
                    fontSize: 11,
                    color: 'var(--fg-4)',
                  }}
                >
                  <span className="mono" style={{ color: 'var(--fg-2)' }}>
                    {request.config.totalDeposited.toFixed(2)}
                  </span>{' '}
                  total
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {canAccept ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      accept.mutate({
                        sender: request.config.sender,
                        streamId: request.config.streamId,
                      })
                    }
                    disabled={accepting}
                  >
                    {accepting ? (
                      <>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            border: '2px solid currentColor',
                            borderTopColor: 'transparent',
                            animation: 'spin 800ms linear infinite',
                          }}
                        />
                        Accepting…
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={13} /> Accept
                      </>
                    )}
                  </button>
                ) : (
                  <span
                    className="badge muted"
                    style={{ fontSize: 11 }}
                    title={request.config.recipient}
                  >
                    Awaiting {partyHint(request.config.recipient)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {accept.error && (
        <div
          style={{
            padding: '10px 18px',
            background: 'color-mix(in oklab, var(--danger) 8%, transparent)',
            borderTop: '1px solid color-mix(in oklab, var(--danger) 25%, var(--line))',
            fontSize: 11.5,
            color: 'var(--danger)',
          }}
        >
          {(accept.error as Error).message}
        </div>
      )}
    </div>
  );
}
