"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";
import { ConvexErrorBoundary } from "./convex-error-boundary";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      // Allow the app to render without Convex (env not yet set) so the
      // user can see the UI shell and configure secrets.
      return null;
    }
    return new ConvexReactClient(url);
  }, []);

  if (!client) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-3">
          <div className="text-3xl">🔥</div>
          <h1 className="text-xl font-semibold text-zinc-100">
            OpenFire is not yet configured
          </h1>
          <p className="text-sm text-zinc-400">
            Set <code className="font-mono">NEXT_PUBLIC_CONVEX_URL</code> in
            your <code className="font-mono">.env.local</code> and run{" "}
            <code className="font-mono">npx convex dev</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ConvexProvider client={client}>
      <ConvexErrorBoundary>{children}</ConvexErrorBoundary>
    </ConvexProvider>
  );
}
