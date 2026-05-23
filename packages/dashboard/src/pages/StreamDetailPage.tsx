/**
 * StreamDetailPage — STR-122 Phase 6 reskin wrapper.
 *
 * Loads the stream via the real `useStream(sender, streamId)` hook and
 * hands the result to the existing `<StreamDetail>` component. Errors +
 * loading states use the Phase 3 primitives.
 *
 * Note: `<StreamDetail>` itself (425 lines) was rebuilt in an earlier
 * pass against the cc-streams aesthetic; this page is just the
 * routing + lifecycle shell.
 */
import { useParams, Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { useStream } from '../hooks/useStreams.js';
import { StreamDetail } from '../components/streams/StreamDetail.js';
import {
  Skeleton,
  ErrorState,
  PageHeader,
} from '../components/common/index.js';

export function StreamDetailPage() {
  const { sender, streamId } = useParams<{ sender: string; streamId: string }>();
  const streamQ = useStream(sender ?? '', streamId ?? '');

  if (!sender || !streamId) {
    return (
      <div style={{ paddingTop: 28 }}>
        <PageHeader title="Stream not found" />
        <ErrorState
          error={new Error('Missing sender or streamId in URL.')}
          title="Bad URL"
        />
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 28 }}>
      <div style={{ marginBottom: 18 }}>
        <Link
          to="/streams"
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
          Back to streams
        </Link>
      </div>

      {streamQ.isPending && (
        <>
          <Skeleton height={32} width={420} style={{ marginBottom: 16 }} />
          <Skeleton.Card minHeight={240} />
          <div style={{ height: 12 }} />
          <Skeleton.Row count={3} height={64} />
        </>
      )}

      {streamQ.isError && (
        <ErrorState
          error={streamQ.error}
          title="Could not load stream"
          onRetry={() => streamQ.refetch()}
        />
      )}

      {streamQ.data && <StreamDetail stream={streamQ.data} />}
    </div>
  );
}
