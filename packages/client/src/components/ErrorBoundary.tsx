import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Uncaught error:", error, info);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-ink-950 flex items-center justify-center p-6">
          <div className="max-w-lg w-full text-center space-y-6">
            <div className="text-6xl">⚠️</div>
            <h1 className="text-2xl font-semibold text-ink-100">
              Something went wrong
            </h1>
            <div className="bg-ink-900 border border-ink-800 rounded-lg p-4 text-left">
              <p className="text-amber-500 text-sm font-mono break-words">
                {this.state.error?.message ?? "Unknown error"}
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2.5 bg-amber-600 hover:bg-amber-500 text-ink-950 font-medium rounded-lg transition-theme cursor-pointer"
            >
              Reload
            </button>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-6 py-2.5 bg-ink-800 hover:bg-ink-700 text-ink-300 font-medium rounded-lg transition-theme cursor-pointer"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
