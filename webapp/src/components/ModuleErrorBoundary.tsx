import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  resetKey: string;
  onRetry: () => void;
  fallback: (error: Error, retry: () => void) => ReactNode;
  children: ReactNode;
}

// The shared application data, auth and drafts live above this boundary.
// A failed module must not unmount the whole React root or trap navigation.
export default class ModuleErrorBoundary extends Component<Props, { error: Error | null; resetKey: string }> {
  state = { error: null as Error | null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: { resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Kiyometa module rendering failed", error, info.componentStack);
  }

  private retry = () => {
    this.props.onRetry();
    this.setState({ error: null });
  };

  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.retry) : this.props.children;
  }
}
