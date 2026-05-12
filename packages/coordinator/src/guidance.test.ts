import type { AgentSession, Fingerprint, TempoConflict } from "@tempo/shared";
import { describe, expect, it } from "vitest";
import { buildAgentSpecificDirective } from "./guidance.js";

const conflict: TempoConflict = {
  id: "conflict-1",
  repoId: "repo-1",
  status: "open",
  risk: "high",
  confidence: 0.8,
  type: "schema",
  title: "Task contract overlap",
  summary: "Two worktrees are changing Task contract.",
  primarySurface: "Task contract",
  affectedWorktreeIds: ["wt-priority", "wt-due"],
  affectedSurfaces: [
    "Task model",
    "Task type",
    "Task API",
    "TaskCard props",
    "TaskComposer component",
    "TodoApp component"
  ],
  evidence: ["Shared contract root: Both worktrees touch Task contract surfaces."],
  riskReasons: [
    {
      label: "Shared contract root",
      detail: "Both worktrees touch Task contract surfaces.",
      weight: 90
    }
  ],
  createdAt: 1778000000000,
  updatedAt: 1778000000001
};

const agents: AgentSession[] = [
  {
    id: "agent-priority",
    repoId: "repo-1",
    worktreeId: "wt-priority",
    agentKind: "codex",
    cwd: "/repo-priority",
    displayName: "codex-priority",
    currentPlan: "Add required task priority support across schema, type, API, and UI. ".repeat(20),
    lastCheckpointAt: 1778000000000,
    joinedAt: 1778000000000
  },
  {
    id: "agent-due",
    repoId: "repo-1",
    worktreeId: "wt-due",
    agentKind: "codex",
    cwd: "/repo-due",
    displayName: "codex-due-date",
    currentPlan: "Add required dueDate support across Task schema and API.",
    lastCheckpointAt: 1778000000000,
    joinedAt: 1778000000000
  }
];

const fingerprints: Fingerprint[] = [
  makeFingerprint("fp-priority", "wt-priority", "priority"),
  makeFingerprint("fp-due", "wt-due", "dueDate")
];

describe("context-bounded guidance", () => {
  it("creates different owner and adapter directives without raw diff context", () => {
    const owner = buildAgentSpecificDirective({
      conflict,
      targetSessionId: "agent-due",
      ownerSessionId: "agent-due",
      agents,
      fingerprints,
      editedDirection: "Use the due date worktree as the contract owner."
    });
    const adapter = buildAgentSpecificDirective({
      conflict,
      targetSessionId: "agent-priority",
      ownerSessionId: "agent-due",
      agents,
      fingerprints,
      editedDirection: "Priority should adapt after due date publishes."
    });

    expect(owner.role).toBe("contract_owner");
    expect(adapter.role).toBe("adapter");
    expect(owner.nextAction).not.toBe(adapter.nextAction);
    expect(adapter.peerAgentName).toBe("codex-due-date");
    expect(adapter.peerIntentSummary).toContain("dueDate");
    expect(JSON.stringify(adapter)).not.toContain("diff --git");
  });

  it("caps context to prevent bloat", () => {
    const directive = buildAgentSpecificDirective({
      conflict,
      targetSessionId: "agent-priority",
      ownerSessionId: "agent-due",
      agents,
      fingerprints,
      editedDirection: "Priority should adapt after due date publishes."
    });

    expect(directive.sharedSurfaces).toHaveLength(5);
    expect(directive.sharedFiles).toHaveLength(5);
    expect(JSON.stringify(directive).length).toBeLessThanOrEqual(1200);
    expect(directive.peerIntentSummary?.length).toBeLessThanOrEqual(140);
  });
});

function makeFingerprint(id: string, worktreeId: string, field: string): Fingerprint {
  return {
    id,
    repoId: "repo-1",
    worktreeId,
    diffHash: `hash-${id}`,
    createdAt: 1778000000000,
    filesTouched: [
      "src/db/schema.ts",
      "src/shared/task.ts",
      "src/app/api/tasks/route.ts",
      "src/app/api/tasks/[id]/route.ts",
      "src/components/TaskCard.tsx",
      "src/components/TaskComposer.tsx"
    ],
    symbols: {
      added: [],
      modified: ["Task", field],
      removed: []
    },
    surfaces: [],
    semanticSummary: `Peer is adding required ${field} to Task.`,
    contractChanges: ["Task contract"],
    confidence: 0.72,
    source: "heuristic"
  };
}
