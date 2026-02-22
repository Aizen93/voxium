import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRecover = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center bg-vox-bg-primary p-8">
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-vox-accent-danger/10">
              <svg className="h-8 w-8 text-vox-accent-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-vox-text-primary">Something went wrong</h2>
            <p className="text-sm text-vox-text-secondary">
              An unexpected error occurred. You can try to recover or reload the page.
            </p>
            {this.state.error && (
              <pre className="w-full rounded-lg bg-vox-bg-secondary p-3 text-left text-xs text-vox-text-muted overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3">
              <button
                onClick={this.handleRecover}
                className="rounded-lg bg-vox-bg-secondary px-4 py-2 text-sm font-medium text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
              >
                Try to Recover
              </button>
              <button
                onClick={this.handleReload}
                className="rounded-lg bg-vox-accent-primary px-4 py-2 text-sm font-medium text-white hover:bg-vox-accent-hover transition-colors"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
