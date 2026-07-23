/**
 * CreateStreamV1Page — thin wrapper around `CreateStreamV1Form`.
 *
 * Mirrors `CreateStreamPage` (the V2 wizard host) but targets the proxy
 * V1 lane. Distinct page so the V1 flow is clearly separate from V2.
 */

import { Link } from 'react-router';
import { Lock } from 'lucide-react';
import { PageHeader } from '../components/common/index.js';
import { CreateStreamV1Form } from '../components/streams/CreateStreamV1Form.js';
import { LaneSwitch } from '../components/streams/LaneSwitch.js';

export function CreateStreamV1Page() {
  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Create a stream"
        subtitle="Direct delivery — the default. Set a per-cycle amount in Canton Coin; each Settle sends it from your wallet to the recipient via a token-standard transfer. Nothing is locked up front, and it works with any wallet."
        actions={<LaneSwitch lane="v1" kind="create" />}
      />

      {/* Cross-link to the "sign once" custodial option. */}
      <Link
        to="/v1/escrows/create"
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 14px',
          marginBottom: 18,
          textDecoration: 'none',
          color: 'var(--fg-2)',
          fontSize: 12.5,
        }}
      >
        <Lock size={15} style={{ color: 'var(--warn)', flexShrink: 0 }} />
        <span>
          Don't want to approve every cycle?{' '}
          <strong style={{ color: 'var(--fg)' }}>Deposit once and let the operator stream it</strong>{' '}
          — a custodied stream (custodial).
        </span>
      </Link>

      <CreateStreamV1Form />
    </div>
  );
}
