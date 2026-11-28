import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last-resort catch for render errors in the app shell. Without it a single
 *  render throw unmounts the whole tree and leaves a blank window. Logging is
 *  handled by the root's `onCaughtError` option (see main.tsx). */
export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-crash" role="alert" data-tauri-drag-region>
        <h1 className="app-crash-title">This window hit a problem</h1>
        <p className="app-crash-body">
          Your chats are saved. Reload to pick up where you left off.
        </p>
        <details className="app-crash-details">
          <summary>Error details</summary>
          <pre>{error.message || String(error)}</pre>
        </details>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => window.location.reload()}
        >
          Reload window
        </button>
      </div>
    );
  }
}
