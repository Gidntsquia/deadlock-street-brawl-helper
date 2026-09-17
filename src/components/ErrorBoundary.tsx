import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../log';

interface Props {
  children: ReactNode;
}
interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    log('error-boundary', 'error', 'ui.error', {
      message: error instanceof Error ? error.message : String(error),
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="error">
        <p>Something went wrong: {this.state.message}</p>
        <button className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
