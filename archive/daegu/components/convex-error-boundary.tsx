"use client";

/**
 * Catches errors thrown by Convex `useQuery` hooks anywhere in the tree
 * and renders a user-facing fallback that explains how to fix the
 * deployment (typically: run `npx convex dev` to push the latest
 * functions). Without this, a single missing public function takes the
 * whole page down with a runtime error.
 *
 * Mounted globally inside `ConvexClientProvider` so every page is
 * protected. Reset is a full reload because Convex query state is
 * connection-scoped — easier than threading a reset signal through every
 * useQuery caller.
 */
import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ConvexErrorBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("[convex] query failed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const missingFn = /Could not find public function for '([^']+)'/.exec(
      error.message
    )?.[1];

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-8">
        <div className="max-w-lg space-y-4 border border-[var(--accent)]/60 bg-[var(--accent-dim)]/15 p-6">
          <div className="text-[8px] font-mono tracking-[0.3em] text-[var(--accent)] uppercase">
            Convex Deployment Out Of Sync
          </div>
          <h1 className="font-display text-xl text-[var(--text)]">
            {missingFn
              ? `Missing function: ${missingFn}`
              : "Backend query failed"}
          </h1>
          <p className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed">
            {missingFn ? (
              <>
                The Convex deployment doesn&apos;t have{" "}
                <code className="text-[var(--accent)]">{missingFn}</code> yet.
                In another terminal run:
              </>
            ) : (
              <>The Convex query failed with: {error.message}</>
            )}
          </p>
          {missingFn ? (
            <pre className="text-[11px] font-mono bg-[var(--bg)] border border-[var(--border)] px-3 py-2 text-[var(--text)]">
              npx convex dev
            </pre>
          ) : null}
          <button
            onClick={() => {
              this.setState({ error: null });
              if (typeof window !== "undefined") window.location.reload();
            }}
            className="text-[10px] font-mono tracking-[0.18em] text-[var(--accent)] hover:text-[var(--accent-bright)] uppercase"
          >
            ↻ Reload
          </button>
        </div>
      </div>
    );
  }
}
