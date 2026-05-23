import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6">
            <h2 className="text-sm font-semibold text-red-800">Something went wrong</h2>
            <p className="mt-1 text-sm text-red-700">
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
