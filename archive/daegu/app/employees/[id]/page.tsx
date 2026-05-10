"use client";

import { useState, use } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DecisionModal, DecisionModalData } from "@/components/decision-modal";
import { EmailThread, EmailMessage } from "@/components/email-thread";
import { Loader2 } from "lucide-react";
import Link from "next/link";

interface Employee {
  _id: string;
  name: string;
  email: string;
  role: string;
  nozomio_entity_id: string;
  status: "active" | "pending" | "fired" | "spared";
}

interface Decision {
  _id: string;
  employee_id: string;
  reasoning: string;
  decision: "fire" | "spare";
  email_draft: string;
  status: "pending" | "approved" | "rejected" | "sent";
  created_at: number;
}

const statusVariant: Record<string, "active" | "pending" | "fired" | "spared"> = {
  active: "active",
  pending: "pending",
  fired: "fired",
  spared: "spared",
};

export default function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const employee = useQuery(api.employees.get, { id: id as never });
  const decisions = useQuery(api.decisions.listForEmployee, { employee_id: id as never });
  const latestDecision = (decisions ?? [])[0] as Decision | undefined;
  const messages = useQuery(
    api.messages.listForDecision,
    latestDecision ? { decision_id: latestDecision._id as never } : "skip"
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [hireBusy, setHireBusy] = useState(false);
  const [hireError, setHireError] = useState<string | null>(null);
  const router = useRouter();

  const hireDigitalReplacement = async () => {
    setHireBusy(true);
    setHireError(null);
    try {
      const res = await fetch("/api/hire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "hire failed");
      router.push(`/digital-employees/${data.digital_employee_id}`);
    } catch (e: unknown) {
      setHireError(e instanceof Error ? e.message : String(e));
    } finally {
      setHireBusy(false);
    }
  };

  if (employee === undefined) {
    return (
      <div className="border border-[var(--border)] bg-[var(--surface)] p-16 text-center">
        <Loader2 className="h-4 w-4 animate-spin mx-auto mb-3 text-[var(--text-dim)]" />
        <p className="text-[10px] font-mono text-[var(--text-dim)] tracking-[0.2em] uppercase">Loading dossier…</p>
      </div>
    );
  }

  if (employee === null) {
    return (
      <div className="border border-[var(--border)] bg-[var(--surface)] p-12 text-center">
        <p className="font-display text-lg text-[var(--text)] mb-3">Dossier not found.</p>
        <Link href="/" className="text-[10px] font-mono text-[var(--accent)] hover:text-[var(--accent-bright)] tracking-[0.15em] uppercase">
          ← Return to roster
        </Link>
      </div>
    );
  }

  const emp = employee as Employee;
  const list = (decisions ?? []) as Decision[];
  const msgs = (messages ?? []) as EmailMessage[];

  return (
    <div className="space-y-8">
      <Link
        href="/"
        className="inline-block text-[9px] font-mono tracking-[0.2em] text-[var(--text-dim)] hover:text-[var(--accent)] transition-colors uppercase"
      >
        ← Roster
      </Link>

      {/* Employee header */}
      <section className="border border-[var(--border)] bg-[var(--surface)] flex overflow-hidden">
        <div className={`w-[3px] shrink-0 ${
          emp.status === "fired" ? "bg-[var(--text-dim)]" :
          emp.status === "pending" ? "bg-[var(--amber)]" :
          emp.status === "spared" ? "bg-[var(--blue)]" :
          "bg-[var(--accent)]"
        }`} />
        <div className="flex-1 p-6">
          <div className="text-[8px] font-mono tracking-[0.25em] text-[var(--text-dim)] uppercase mb-3">
            Personnel File · #{emp._id.slice(-6).toUpperCase()}
          </div>
          <div className="flex items-start gap-3 flex-wrap mb-4">
            <h1 className="font-display text-3xl font-semibold text-[var(--text)] leading-none">
              {emp.name}
            </h1>
            <Badge variant={statusVariant[emp.status]}>{emp.status}</Badge>
          </div>
          <div className="space-y-1.5">
            <InfoRow label="Role" value={emp.role} />
            <InfoRow label="Email" value={emp.email} />
            <InfoRow label="Nozomio" value={emp.nozomio_entity_id} />
          </div>
        </div>
      </section>

      {emp.status === "fired" ? (
        <section>
          <SectionLabel>Hire Digital Replacement</SectionLabel>
          <div className="border border-[var(--border)] bg-[var(--surface)] flex overflow-hidden">
            <div className="w-[3px] shrink-0 bg-[var(--accent)]" />
            <div className="flex-1 p-5 space-y-4">
              <p className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed">
                Spawn a digital employee with {emp.name}&apos;s institutional
                knowledge. Provisions a real AgentMail inbox, transfers the
                Nia source bundle into a fresh entity namespace, publishes an
                A2A agent card, and sends an onboarding email from the new
                inbox.
              </p>
              <Button
                onClick={hireDigitalReplacement}
                disabled={hireBusy}
                variant="default"
                size="sm"
              >
                {hireBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-2" />
                ) : null}
                Hire Digital Replacement →
              </Button>
              {hireError ? (
                <div className="border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-[10px] font-mono text-[var(--accent)]">
                  {hireError}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {/* Latest decision */}
      {latestDecision ? (
        <section>
          <SectionLabel>Latest Decision</SectionLabel>
          <div className="border border-[var(--border)] bg-[var(--surface)] flex overflow-hidden">
            <div className={`w-[3px] shrink-0 ${latestDecision.decision === "fire" ? "bg-[var(--accent)]" : "bg-[var(--blue)]"}`} />
            <div className="flex-1 p-5 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={latestDecision.decision === "fire" ? "active" : "spared"}>
                  {latestDecision.decision === "fire" ? "Terminate" : "Spare"}
                </Badge>
                <Badge variant={
                  latestDecision.status === "sent" ? "fired" :
                  latestDecision.status === "rejected" ? "spared" : "pending"
                }>
                  {latestDecision.status}
                </Badge>
                <span className="text-[9px] font-mono text-[var(--text-dim)] ml-auto">
                  {new Date(latestDecision.created_at).toLocaleString()}
                </span>
              </div>
              <div>
                <div className="text-[8px] font-mono tracking-[0.2em] text-[var(--text-dim)] uppercase mb-2">Reasoning</div>
                <p className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap">
                  {latestDecision.reasoning}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
                Review Email Draft →
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {/* Email thread */}
      <section>
        <SectionLabel>Email Thread</SectionLabel>
        <EmailThread messages={msgs} />
      </section>

      {/* Decision history */}
      {list.length > 1 ? (
        <section>
          <SectionLabel>Decision History</SectionLabel>
          <div className="space-y-2">
            {list.slice(1).map((d) => (
              <div key={d._id} className="border border-[var(--border)] bg-[var(--surface)] p-4 flex items-center justify-between">
                <span className="text-[10px] font-mono text-[var(--text-dim)]">
                  {new Date(d.created_at).toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Badge variant={d.decision === "fire" ? "active" : "spared"}>{d.decision}</Badge>
                  <Badge>{d.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <DecisionModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        decision={(latestDecision as DecisionModalData) ?? null}
        employeeName={emp.name}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[8px] font-mono tracking-[0.18em] text-[var(--text-dim)] uppercase w-16 shrink-0">{label}</span>
      <span className="text-[11px] font-mono text-[var(--text-muted)]">{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className="h-[1px] w-4 bg-[var(--border-raised)]" />
      <span className="text-[9px] font-mono tracking-[0.22em] text-[var(--text-dim)] uppercase">{children}</span>
    </div>
  );
}
