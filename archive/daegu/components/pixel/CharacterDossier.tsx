"use client";

/**
 * CharacterDossier — LinkedIn-style modal that opens when the user
 * clicks a pixel character in the office. Shows avatar, role,
 * status, current task, and a progress bar.
 *
 * Demo mode: the entity prop carries enough info to render a canned
 * brief without hitting Convex. When live, the dossier can be
 * extended to read worker_tasks / decisions via useQuery; the
 * structure here is the same.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { OfficeEntity } from "./PixelOffice";

const ROLE_LABEL: Record<string, string> = {
  engineer: "Senior Software Engineer",
  gtm: "Outbound SDR",
  recruiter: "Technical Recruiter",
  cse: "Customer Success Engineer",
  pm: "Product Manager",
  researcher: "Research Analyst",
};

interface DossierData {
  headline: string;
  role: string;
  team: string;
  badge: { variant: "active" | "pending" | "fired" | "spared"; label: string };
  currentTask: string | null;
  progressPct: number; // 0..100
  recent: string[];
  bio: string;
}

function deriveDossier(entity: OfficeEntity): DossierData {
  if (entity.kind === "worker") {
    // Worker name often "<Name>-<RoleHint>" in demo (e.g. "Hank-Eng").
    const roleHint = entity.name.split("-")[1]?.toLowerCase() ?? "";
    const roleKey =
      roleHint.startsWith("eng") ? "engineer"
      : roleHint.startsWith("pm") ? "pm"
      : roleHint.startsWith("res") ? "researcher"
      : roleHint.startsWith("rec") ? "recruiter"
      : roleHint.startsWith("cse") ? "cse"
      : roleHint.startsWith("gtm") || roleHint.startsWith("sd") ? "gtm"
      : "engineer";
    const role = ROLE_LABEL[roleKey];
    const fired = entity.status === "fired";
    return {
      headline: `${role} at OpenFire · Iron Claw`,
      role,
      team: "Iron Claw",
      badge: fired
        ? { variant: "fired", label: "Decommissioned" }
        : { variant: "active", label: entity.busy ? "On Task" : "Standby" },
      currentTask: fired
        ? null
        : entity.busy
          ? sampleTaskFor(roleKey)
          : "Awaiting brief from manager.",
      progressPct: fired ? 100 : entity.busy ? 60 : 0,
      recent: fired
        ? ["Final report submitted.", "Account access revoked."]
        : entity.busy
          ? sampleStepsFor(roleKey)
          : ["Inbox empty.", "Watching #briefs channel."],
      bio: `Autonomous AI worker. Runs an Anthropic tool-use loop with role-specific tools, logs every reasoning step to the deliberation feed, and closes tasks via mark_task_done.`,
    };
  }
  // Employee
  switch (entity.status) {
    case "fired":
      return {
        headline: "Former employee at OpenFire",
        role: "Employee",
        team: "Alumni",
        badge: { variant: "fired", label: "Terminated" },
        currentTask: null,
        progressPct: 100,
        recent: [
          "Termination email dispatched.",
          "Calendar exit interview scheduled.",
          "Slack access revoked.",
        ],
        bio: "The Claw flagged this employee against the active fire criteria and the manager approved.",
      };
    case "pending":
      return {
        headline: "Under review at OpenFire",
        role: "Employee",
        team: "Engineering",
        badge: { variant: "pending", label: "Awaiting Verdict" },
        currentTask: "Decision pending manager approval.",
        progressPct: 80,
        recent: [
          "Composite score crossed firing threshold.",
          "Reasoning compiled by The Claw.",
          "Email draft prepared.",
        ],
        bio: "The Claw has rendered judgment. Awaiting human approve / reject.",
      };
    case "spared":
      return {
        headline: "Reinstated at OpenFire",
        role: "Employee",
        team: "Engineering",
        badge: { variant: "spared", label: "Spared" },
        currentTask: "Back at desk. Performance under monitoring.",
        progressPct: 20,
        recent: [
          "Manager rejected termination.",
          "Status restored to active.",
          "Quarterly review queued.",
        ],
        bio: "Manager overrode The Claw on this one. Probationary monitoring in place.",
      };
    case "active":
    default:
      return {
        headline: "Employee at OpenFire",
        role: "Employee",
        team: "Engineering",
        badge: { variant: "active", label: "On Track" },
        currentTask: "Standard duties. Performance metrics nominal.",
        progressPct: 35,
        recent: [
          "Last sprint shipped on time.",
          "Code review participation healthy.",
          "Slack response within SLA.",
        ],
        bio: "Active employee on the roster. The Claw monitors performance against the live fire criteria.",
      };
  }
}

function sampleTaskFor(role: string): string {
  switch (role) {
    case "engineer":
      return "Investigating an auth-token expiry regression introduced in v2.4.";
    case "pm":
      return "Drafting Q3 spec for the inbox triage feature.";
    case "researcher":
      return "Compiling a brief on inventory carrying-cost benchmarks.";
    case "recruiter":
      return "Sourcing candidates for the staff-platform-engineer opening.";
    case "cse":
      return "Resolving a tier-1 customer billing escalation.";
    case "gtm":
      return "Outreach round for 12 Series-A fintechs that just raised.";
    default:
      return "Working a brief.";
  }
}

function sampleStepsFor(role: string): string[] {
  switch (role) {
    case "engineer":
      return [
        "search_codebase('token expiry')",
        "read_file('auth/middleware.ts')",
        "propose_pr — fix &lt; vs &lt;= guard",
      ];
    case "pm":
      return ["search_research", "draft_spec — 4 sections complete", "broadcast_question to engineers"];
    case "researcher":
      return ["search_papers (3 hits)", "read_source on lead paper", "drafting TL;DR"];
    case "recruiter":
      return ["source_candidates (12 found)", "screen_resume × 5", "draft_outreach (top 3)"];
    case "cse":
      return ["search_past_tickets", "search_logs (no errors)", "draft_reply ready"];
    case "gtm":
      return ["research_company × 4", "find_decision_maker", "draft_cold_email — angle: recent-news"];
    default:
      return ["log_reasoning_step", "tool call", "tool result"];
  }
}

export function CharacterDossier({
  entity,
  open,
  onOpenChange,
}: {
  entity: OfficeEntity | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  if (!entity) return null;
  const d = deriveDossier(entity);

  // CSS-cropped avatar from the 112×96 character sheet — frame 1 (idle)
  // of row 0 (down). Sheet is rendered at 3× pixel-perfect.
  const sheetW = 112 * 3;
  const sheetH = 96 * 3;
  const frameW = 16 * 3;
  const frameH = 32 * 3;
  const avatarStyle: React.CSSProperties = {
    width: frameW,
    height: frameH,
    backgroundImage: `url(/assets/pixel/characters/char_${entity.paletteIdx % 6}.png)`,
    backgroundSize: `${sheetW}px ${sheetH}px`,
    backgroundPosition: `-${frameW}px 0px`,
    imageRendering: "pixelated",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              style={avatarStyle}
              className="border border-[var(--border)] bg-[var(--surface-raised)] shrink-0"
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <DialogTitle className="flex items-center gap-2 flex-wrap">
                <span>{entity.name}</span>
                <Badge variant={d.badge.variant}>{d.badge.label}</Badge>
              </DialogTitle>
              <DialogDescription>
                {d.headline}
              </DialogDescription>
              <div className="mt-2 flex gap-3 text-[10px] font-mono text-[var(--text-dim)]">
                <span>
                  <span className="text-[var(--text-muted)]">Role:</span>{" "}
                  <span className="text-[var(--text)]">{d.role}</span>
                </span>
                <span>
                  <span className="text-[var(--text-muted)]">Team:</span>{" "}
                  <span className="text-[var(--text)]">{d.team}</span>
                </span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 max-h-[55vh] overflow-y-auto pr-1">
          <Section label="About">
            <p className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed">
              {d.bio}
            </p>
          </Section>

          {d.currentTask ? (
            <Section label="Currently Working On">
              <p className="text-[11px] font-mono text-[var(--text)] leading-relaxed mb-3">
                {d.currentTask}
              </p>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-1.5 bg-[var(--border)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)]"
                    style={{ width: `${d.progressPct}%` }}
                  />
                </div>
                <span className="text-[9px] font-mono tracking-[0.2em] text-[var(--text-dim)] uppercase shrink-0">
                  {d.progressPct}%
                </span>
              </div>
            </Section>
          ) : null}

          <Section label="Recent Activity">
            <ul className="space-y-1.5">
              {d.recent.map((r, i) => (
                <li
                  key={i}
                  className="text-[11px] font-mono text-[var(--text-muted)] leading-relaxed flex gap-2"
                >
                  <span className="text-[var(--accent)] shrink-0">·</span>
                  <span dangerouslySetInnerHTML={{ __html: r }} />
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[8px] font-mono tracking-[0.22em] text-[var(--text-dim)] uppercase mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}
