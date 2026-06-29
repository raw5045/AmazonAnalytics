'use client';

import { Component, type ReactNode } from 'react';

/**
 * Local error boundary for isolating a failing subtree (e.g. a streamed
 * <Suspense> child) so the rest of the page survives. Use this for
 * "keep the page, replace just this box"; for full route-segment errors use
 * error.tsx instead.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[error boundary]', error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
