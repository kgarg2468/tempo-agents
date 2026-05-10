"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { EmployeeCard, EmployeeCardData } from "@/components/employee-card";
import { Loader2 } from "lucide-react";

export default function PyrePage() {
  const employees = useQuery(api.employees.list);

  const list = (employees ?? []) as EmployeeCardData[];
  const fired = list.filter((e) => e.status === "fired");
  const spared = list.filter((e) => e.status === "spared");

  return (
    <div className="space-y-10">
      <section className="pb-6 border-b border-[var(--border)]">
        <div className="text-[8px] font-mono tracking-[0.3em] text-[var(--text-dim)] uppercase mb-2">
          Openfire · Archive
        </div>
        <h1 className="font-display text-4xl font-semibold text-[var(--text)] leading-none">
          The Pyre
        </h1>
        <p className="text-[11px] font-mono text-[var(--text-muted)] mt-2.5">
          Those whose cases have been resolved. Click any dossier to view the email thread.
        </p>
      </section>

      {employees === undefined ? (
        <div className="border border-[var(--border)] bg-[var(--surface)] p-16 text-center">
          <Loader2 className="h-4 w-4 animate-spin mx-auto mb-3 text-[var(--text-dim)]" />
          <p className="text-[10px] font-mono text-[var(--text-dim)] tracking-[0.2em] uppercase">
            Loading archive…
          </p>
        </div>
      ) : (
        <>
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-[1px] w-4 bg-[var(--accent)]" />
              <h2 className="text-[9px] font-mono tracking-[0.25em] text-[var(--accent)] uppercase">
                Terminated — {fired.length}
              </h2>
            </div>
            {fired.length === 0 ? (
              <div className="border border-[var(--border)] bg-[var(--surface)] p-10 text-center">
                <p className="text-[11px] font-mono text-[var(--text-dim)]">No terminations on record. The pyre is cold.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {fired.map((e, i) => (
                  <div key={e._id} style={{ animationDelay: `${i * 55}ms` }}>
                    <EmployeeCard employee={e} />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-[1px] w-4 bg-[var(--blue)]" />
              <h2 className="text-[9px] font-mono tracking-[0.25em] text-[var(--blue-text)] uppercase">
                Spared — {spared.length}
              </h2>
            </div>
            {spared.length === 0 ? (
              <div className="border border-[var(--border)] bg-[var(--surface)] p-10 text-center">
                <p className="text-[11px] font-mono text-[var(--text-dim)]">No survivors yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {spared.map((e, i) => (
                  <div key={e._id} style={{ animationDelay: `${i * 55}ms` }}>
                    <EmployeeCard employee={e} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
