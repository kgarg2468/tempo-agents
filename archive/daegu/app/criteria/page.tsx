"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2, Plus } from "lucide-react";

interface Criterion {
  _id: string;
  name: string;
  description: string;
  weight: number;
  active: boolean;
}

export default function CriteriaPage() {
  const criteria = useQuery(api.criteria.list);
  const createCriterion = useMutation(api.criteria.create);
  const toggleCriterion = useMutation(api.criteria.toggle);
  const removeCriterion = useMutation(api.criteria.remove);

  const [form, setForm] = useState({ name: "", description: "", weight: 1 });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createCriterion({ name: form.name, description: form.description, weight: form.weight });
      setForm({ name: "", description: "", weight: 1 });
    } finally {
      setSubmitting(false);
    }
  };

  const list = (criteria ?? []) as Criterion[];

  return (
    <div className="space-y-8">
      <section className="pb-6 border-b border-[var(--border)]">
        <div className="text-[8px] font-mono tracking-[0.3em] text-[var(--text-dim)] uppercase mb-2">
          Openfire · Configuration
        </div>
        <h1 className="font-display text-4xl font-semibold text-[var(--text)] leading-none">
          Fire Criteria
        </h1>
        <p className="text-[11px] font-mono text-[var(--text-muted)] mt-2.5">
          Rules The Claw uses to evaluate employees. Higher weight = stronger influence.
        </p>
      </section>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Add form */}
        <div className="lg:col-span-1 h-fit border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] px-5 py-3">
            <h2 className="text-[9px] font-mono tracking-[0.2em] text-[var(--text-dim)] uppercase">
              New Criterion
            </h2>
          </div>
          <form onSubmit={submit} className="p-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cname">Name</Label>
              <Input
                id="cname"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="3+ missed deadlines"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cdesc">Description</Label>
              <Textarea
                id="cdesc"
                required
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Missed at least 3 deadlines in 30 days."
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cw">Weight (1–10)</Label>
              <Input
                id="cw"
                type="number"
                min={1}
                max={10}
                value={form.weight}
                onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
              />
            </div>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              Add Criterion
            </Button>
          </form>
        </div>

        {/* Criteria list */}
        <div className="lg:col-span-2 space-y-2">
          {criteria === undefined ? (
            <div className="border border-[var(--border)] bg-[var(--surface)] p-10 text-center">
              <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2 text-[var(--text-dim)]" />
              <p className="text-[10px] font-mono text-[var(--text-dim)] tracking-[0.2em] uppercase">Loading rules…</p>
            </div>
          ) : list.length === 0 ? (
            <div className="border border-[var(--border)] bg-[var(--surface)] p-16 text-center">
              <p className="font-display text-lg text-[var(--text)]">No criteria set.</p>
              <p className="text-[11px] font-mono text-[var(--text-muted)] mt-1">
                Without criteria, The Claw will be very forgiving.
              </p>
            </div>
          ) : (
            list.map((c) => (
              <div key={c._id} className="border border-[var(--border)] bg-[var(--surface)] flex">
                {/* Weight bar */}
                <div
                  className="w-[3px] shrink-0 transition-opacity"
                  style={{
                    background: c.active ? `var(--accent)` : `var(--text-dim)`,
                    opacity: c.active ? 0.8 : 0.4,
                  }}
                />
                <div className="flex-1 p-4 flex items-start gap-4 min-w-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-display text-sm font-semibold text-[var(--text)]">{c.name}</h3>
                      <Badge variant={c.active ? "active" : "fired"}>
                        {c.active ? "active" : "disabled"}
                      </Badge>
                      <span className="text-[8px] font-mono tracking-[0.15em] text-[var(--text-dim)] uppercase border border-[var(--border)] px-1.5 py-0.5">
                        W:{c.weight}
                      </span>
                    </div>
                    <p className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed">{c.description}</p>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant={c.active ? "outline" : "secondary"}
                      onClick={() => toggleCriterion({ id: c._id as never })}
                    >
                      {c.active ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeCriterion({ id: c._id as never })}
                      className="text-[var(--accent)] hover:text-[var(--accent-bright)] hover:bg-[var(--accent-dim)]/20"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
