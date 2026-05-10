"use client";

/**
 * /office — pixel-art live view of the OpenFire roster.
 *
 * Each employee and active worker becomes a character in a 30×18 tile
 * canvas. Status drives where they walk:
 *   - active employee → desk (top), idle/typing
 *   - pending employee → orange "court" tiles in the center
 *   - fired employee → exit door (gray-tinted)
 *   - spared employee → back to a desk
 *   - active worker → workstation (bottom), typing if busy
 *
 * Demo mode: append `?demo=1` to bypass Convex and render a canned
 * roster so the visual works without a backend deployed. This is the
 * mode used by the visual smoke test.
 */
import { Suspense, useState, Component, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PixelOffice, OfficeEntity } from "@/components/pixel/PixelOffice";
import { CharacterDossier } from "@/components/pixel/CharacterDossier";
import Link from "next/link";

/**
 * Catches Convex query failures (e.g. functions not yet pushed to the
 * deployment, network error, schema mismatch) and renders the demo
 * roster instead of crashing the whole page. The UI surfaces the error
 * so the developer knows to run `npx convex dev` or fix their config.
 */
class OfficeErrorBoundary extends Component<
  { fallback: (err: Error) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.warn("[/office] live data unavailable, falling back to demo:", error);
  }
  render() {
    if (this.state.error) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

const DEMO_ROSTER: OfficeEntity[] = [
  { id: "e1", name: "Alice", kind: "employee", status: "active", paletteIdx: 0 },
  { id: "e2", name: "Bob", kind: "employee", status: "active", paletteIdx: 1 },
  { id: "e3", name: "Carol", kind: "employee", status: "pending", paletteIdx: 2 },
  { id: "e4", name: "Dave", kind: "employee", status: "fired", paletteIdx: 3 },
  { id: "e5", name: "Eve", kind: "employee", status: "spared", paletteIdx: 4 },
  { id: "w1", name: "Hank-Eng", kind: "worker", status: "active", paletteIdx: 5, busy: true },
  { id: "w2", name: "Mara-PM", kind: "worker", status: "active", paletteIdx: 0, busy: false },
  { id: "w3", name: "Iris-Res", kind: "worker", status: "active", paletteIdx: 1, busy: true },
];

interface ConvexEmployee {
  _id: string;
  name: string;
  status: "active" | "pending" | "fired" | "spared";
}

interface ConvexWorker {
  _id: string;
  name: string;
  status: "active" | "fired";
}

export default function OfficePage() {
  return (
    <Suspense fallback={<OfficeLoading />}>
      <OfficeErrorBoundary
        fallback={(err) => (
          <OfficeDemoFallback errorMessage={err.message} />
        )}
      >
        <OfficePageInner />
      </OfficeErrorBoundary>
    </Suspense>
  );
}

function OfficeDemoFallback({ errorMessage }: { errorMessage: string }) {
  const missingFn = /Could not find public function for '([^']+)'/.exec(
    errorMessage
  )?.[1];
  return (
    <div className="space-y-6 text-center">
      <div className="border border-[var(--accent)]/60 bg-[var(--accent-dim)]/20 p-4 mx-auto max-w-3xl text-left">
        <p className="text-[10px] font-mono tracking-[0.2em] text-[var(--accent)] uppercase mb-2">
          Live data unavailable — showing demo roster
        </p>
        <p className="text-[10px] font-mono text-[var(--text-muted)] leading-relaxed">
          {missingFn ? (
            <>
              Convex deployment is missing <code>{missingFn}</code>. Run{" "}
              <code className="text-[var(--accent)]">npx convex dev</code> in
              another terminal to push the latest functions, then reload.
            </>
          ) : (
            <>Backend query failed: {errorMessage}</>
          )}
        </p>
      </div>
      <div className="w-full flex justify-center">
        <OfficeWithDossier entities={DEMO_ROSTER} />
      </div>
    </div>
  );
}

function OfficeLoading() {
  return (
    <div className="border border-[var(--border)] bg-[var(--surface)] p-16 text-center">
      <p className="text-[10px] font-mono text-[var(--text-dim)] tracking-[0.2em] uppercase">
        Loading office…
      </p>
    </div>
  );
}

function OfficePageInner() {
  const sp = useSearchParams();
  const demo = sp.get("demo") === "1";

  const employees = useQuery(api.employees.list);
  const workers = useQuery(api.workers.listActive);

  // Map Convex docs to OfficeEntity. Color palette deterministic by _id
  // so the same person keeps the same outfit across renders.
  const realEntities: OfficeEntity[] = [
    ...((employees as ConvexEmployee[] | undefined) ?? []).map((e, i) => ({
      id: e._id,
      name: e.name,
      kind: "employee" as const,
      status: e.status,
      paletteIdx: i,
    })),
    ...((workers as ConvexWorker[] | undefined) ?? []).map((w, i) => ({
      id: w._id,
      name: w.name,
      kind: "worker" as const,
      status: w.status,
      paletteIdx: (i + 3) % 6,
      busy: true, // No per-task wiring yet; assume active workers are busy.
    })),
  ];

  // Use demo roster when explicitly requested OR when no real data is
  // loaded yet (queries undefined → backend not configured / loading).
  const queriesLoaded = employees !== undefined || workers !== undefined;
  const entities =
    demo || !queriesLoaded || realEntities.length === 0
      ? DEMO_ROSTER
      : realEntities;

  // The 1440px canvas is wider than the root layout's max-w-6xl, so we
  // use a fixed-position viewport overlay for the canvas wrapper. That
  // way the canvas centers cleanly on the actual viewport regardless of
  // what max-width / flex / grid the parent uses, and we don't have to
  // fight CSS at every level. Other content stays in the normal flow.
  return (
    <div className="space-y-6 text-center">
      <section className="pb-6 border-b border-[var(--border)] mx-auto max-w-3xl">
        <div className="text-[8px] font-mono tracking-[0.3em] text-[var(--text-dim)] uppercase mb-2">
          Openfire · Live View
        </div>
        <h1 className="font-display text-4xl font-semibold text-[var(--text)] leading-none">
          The Office
        </h1>
        <p className="text-[11px] font-mono text-[var(--text-muted)] mt-2.5 tracking-wide">
          Watch The Claw move people in real time. Court tiles in the
          center; exit door bottom-right. {demo ? "(demo mode)" : ""}
        </p>
        <div className="mt-3 flex justify-center gap-3 text-[10px] font-mono">
          <Link
            href={demo ? "/office" : "/office?demo=1"}
            className="text-[var(--accent)] hover:text-[var(--accent-bright)] tracking-[0.15em] uppercase"
          >
            {demo ? "→ Use live data" : "→ Switch to demo mode"}
          </Link>
          <Link
            href="/"
            className="text-[var(--text-dim)] hover:text-[var(--accent)] tracking-[0.15em] uppercase"
          >
            ← Back to roster
          </Link>
        </div>
      </section>

      <div className="w-full flex justify-center">
        <OfficeWithDossier entities={entities} />
      </div>

      <section className="grid sm:grid-cols-4 gap-3 text-[10px] font-mono mx-auto max-w-3xl">
        <Legend swatch="active" label="Desk · idle/typing" />
        <Legend swatch="pending" label="Court · awaiting verdict" />
        <Legend swatch="fired" label="Exit · grayed out" />
        <Legend swatch="worker" label="Workstation · AI worker" />
      </section>
      <p className="text-[10px] font-mono text-[var(--text-dim)] tracking-wide">
        Tip: click any character for a dossier — role, current task, progress.
      </p>
    </div>
  );
}

function OfficeWithDossier({ entities }: { entities: OfficeEntity[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId
    ? (entities.find((e) => e.id === selectedId) ?? null)
    : null;
  return (
    <>
      <PixelOffice entities={entities} onSelect={setSelectedId} />
      <CharacterDossier
        entity={selected}
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setSelectedId(null);
        }}
      />
    </>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  const color =
    swatch === "active"
      ? "var(--text)"
      : swatch === "pending"
        ? "var(--accent)"
        : swatch === "fired"
          ? "var(--text-dim)"
          : "var(--blue)";
  return (
    <div className="flex items-center gap-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <span
        className="inline-block w-2 h-2"
        style={{ background: color }}
      />
      <span className="text-[var(--text-muted)]">{label}</span>
    </div>
  );
}
