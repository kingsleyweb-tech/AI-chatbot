import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ui] render error:', error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const chunkError = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(
      this.state.error.message,
    );
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-base font-semibold">Something went wrong</h2>
        <p className="max-w-sm text-sm text-muted">
          {chunkError
            ? 'A newer version of the app is available, or the connection dropped while loading.'
            : 'This part of the app hit an unexpected error. Your conversations are safe.'}
        </p>
        <div className="flex gap-2">
          <button
            className="h-9 rounded-[10px] bg-accent px-4 text-sm font-medium text-accent-fg"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <button
            className="h-9 rounded-[10px] bg-surface-2 px-4 text-sm font-medium"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
