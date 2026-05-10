"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { EmployeeCard, EmployeeCardData } from "@/components/employee-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Loader2, AlertTriangle } from "lucide-react";

export default function HomePage() {
  const employees = useQuery(api.employees.list);
  const createEmployee = useMutation(api.employees.create);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "",
    nozomio_entity_id: "",
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createEmployee(form);
      setForm({ name: "", email: "", role: "", nozomio_entity_id: "" });
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const lightFuse = async (id: string) => {
    setRunning(id);
    setError(null);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: id }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || "Agent run failed");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const list = (employees ?? []) as EmployeeCardData[];
  const visible = list.filter((e) => e.status === "pending" || e.status === "active");

  return (
    <div className="space-y-8">
      <section className="pb-6 border-b border-[var(--border)]">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[8px] font-mono tracking-[0.3em] text-[var(--text-dim)] uppercase mb-2">
              Openfire · Active Roster
            </div>
            <h1 className="font-display text-4xl font-semibold text-[var(--text)] leading-none">
              Pending Departures
            </h1>
            <p className="text-[11px] font-mono text-[var(--text-muted)] mt-2.5 tracking-wide">
              Initiate The Claw on any active employee. Decisions are final.
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-3 w-3" />
            Add Subject
          </Button>
        </div>
      </section>

      {error ? (
        <div className="flex items-start gap-3 border border-[var(--accent)]/60 bg-[var(--accent-dim)]/20 p-4">
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--accent)] shrink-0 mt-0.5" />
          <p className="text-[11px] font-mono text-[var(--accent)]">{error}</p>
        </div>
      ) : null}

      {employees === undefined ? (
        <div className="border border-[var(--border)] bg-[var(--surface)] p-16 text-center">
          <Loader2 className="h-4 w-4 animate-spin mx-auto mb-3 text-[var(--text-dim)]" />
          <p className="text-[10px] font-mono text-[var(--text-dim)] tracking-[0.2em] uppercase">
            Loading roster…
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="border border-[var(--border)] bg-[var(--surface)] p-20 text-center">
          <div className="text-5xl mb-4 flicker">🔥</div>
          <p className="font-display text-2xl text-[var(--text)] mb-2">The smoke clears.</p>
          <p className="text-[11px] font-mono text-[var(--text-muted)]">
            No subjects on the roster. Add one to begin.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visible.map((emp, i) => (
            <div
              key={emp._id}
              className="relative"
              style={{ animationDelay: `${i * 55}ms` }}
            >
              <EmployeeCard employee={emp} onLightFuse={lightFuse} />
              {running === emp._id ? (
                <div className="absolute inset-0 bg-[var(--bg)]/85 backdrop-blur-sm flex flex-col items-center justify-center gap-3 z-10">
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
                  <div className="text-[9px] font-mono tracking-[0.25em] text-[var(--accent)] uppercase flicker">
                    The Claw deliberates…
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>Register Subject</DialogTitle>
            <DialogDescription>
              Add an employee to the active roster. They will await evaluation by The Claw.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Full Name" id="name">
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Jane Doe"
              />
            </Field>
            <Field label="Email Address" id="email">
              <Input
                id="email"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="jane@example.com"
              />
            </Field>
            <Field label="Role / Title" id="role">
              <Input
                id="role"
                required
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                placeholder="Senior Software Engineer"
              />
            </Field>
            <Field label="Nozomio Entity ID" id="nz">
              <Input
                id="nz"
                required
                value={form.nozomio_entity_id}
                onChange={(e) => setForm({ ...form, nozomio_entity_id: e.target.value })}
                placeholder="ent_abc123"
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Register
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
