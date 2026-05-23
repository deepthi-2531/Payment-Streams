import { useLocation, Link } from 'react-router';
import { AlertCircle, ArrowLeft } from 'lucide-react';

/**
 * 404 / catch-all page.
 *
 * Wired in `routes.tsx` as `<Route path="*" element={<NotFoundPage />} />`
 * so any unknown URL — whether a typo, a renamed route, or a stale
 * bookmark — lands here instead of rendering a blank page.
 */
export function NotFoundPage() {
  const location = useLocation();

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <h2 className="text-base font-semibold text-gray-900">Page not found</h2>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-700">
            The page you&rsquo;re looking for doesn&rsquo;t exist or has been moved.
          </p>
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 font-mono text-xs text-gray-600 break-all">
            {location.pathname}
            {location.search}
            {location.hash}
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Return to Dashboard
            </Link>
            <Link
              to="/streams"
              className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              View Streams
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
