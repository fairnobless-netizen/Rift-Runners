import React from 'react';
import { DEBUG_UI_ENABLED } from '../debugFlags';

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
  stack: string | null;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    stack: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, stack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ error, stack: info.componentStack || null });
  }

  private onReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main className="error-boundary" role="alert" aria-live="assertive">
        <h1>Something went wrong</h1>
        <button type="button" onClick={this.onReload}>Reload</button>
        {DEBUG_UI_ENABLED && (
          <details>
            <summary>Error details</summary>
            <pre>{this.state.error.message}</pre>
            <pre>{this.state.error.stack}</pre>
            {this.state.stack && <pre>{this.state.stack}</pre>}
          </details>
        )}
      </main>
    );
  }
}
