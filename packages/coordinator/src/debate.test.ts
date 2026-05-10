import { describe, expect, it } from "vitest";
import type { Fingerprint, RebaseConflict } from "@rebase/shared";
import { createLocalDebateVerdict, estimateTokenCost, withDebate } from "./debate.js";

describe("local debate and token-cost estimation", () => {
  it("classifies conflicting todo Task contract edits as blocking with cost inputs", () => {
    const conflict = taskConflict({
      risk: "high",
      classificationKind: "blocking_conflict"
    });

    const debated = withDebate(conflict, [
      fingerprint("wt-priority", "Adds required Task.priority."),
      fingerprint("wt-due", "Renames Task.title while adding dueDate.")
    ]);

    expect(debated.debate?.verdict).toBe("blocking");
    expect(debated.debate?.directions).toContain(
      "Owner publishes the contract shape through checkpoint."
    );
    expect(debated.tokenCostEstimate?.inputs).toMatchObject({
      filesTouched: 1,
      touchedSurfaces: 2,
      riskMultiplier: 2
    });
  });

  it("keeps compatible additive todo Task edits as a notice rather than a pause", () => {
    const conflict = taskConflict({
      risk: "medium",
      classificationKind: "coordination_notice"
    });

    const verdict = createLocalDebateVerdict(conflict, [
      fingerprint("wt-priority", "Adds Task.priority."),
      fingerprint("wt-due", "Adds Task.dueDate.")
    ]);
    const estimate = estimateTokenCost(conflict, [
      fingerprint("wt-priority", "Adds Task.priority."),
      fingerprint("wt-due", "Adds Task.dueDate.")
    ]);

    expect(verdict.verdict).toBe("notice");
    expect(verdict.judge).toContain("Continue with a checkpoint");
    expect(estimate.formula).toContain("reworkMultiplier");
  });
});

function taskConflict(input: {
  risk: RebaseConflict["risk"];
  classificationKind: NonNullable<RebaseConflict["classification"]>["kind"];
}): RebaseConflict {
  return {
    id: `conflict-${input.classificationKind}`,
    repoId: "repo-1",
    status: "open",
    risk: input.risk,
    confidence: 0.82,
    type: "schema",
    title: "Task contract overlap",
    summary: "Two worktrees are changing Task contract surfaces.",
    primarySurface: "Task contract",
    affectedWorktreeIds: ["wt-priority", "wt-due"],
    affectedSurfaces: ["Task model", "Task type"],
    evidence: ["Both fingerprints touch Task model"],
    riskReasons: [],
    classification: {
      kind: input.classificationKind,
      rationale: "Todo Task changes touch the same contract.",
      source: "fallback",
      confidence: 0.8
    },
    createdAt: 1778000000000,
    updatedAt: 1778000000001
  };
}

function fingerprint(worktreeId: string, semanticSummary: string): Fingerprint {
  return {
    id: `fp-${worktreeId}`,
    repoId: "repo-1",
    worktreeId,
    diffHash: `hash-${worktreeId}`,
    createdAt: 1778000000000,
    filesTouched: ["src/shared/task.ts"],
    symbols: { added: [], modified: ["Task"], removed: [] },
    surfaces: [
      {
        id: "task-type",
        label: "Task type",
        kind: "type",
        files: ["src/shared/task.ts"],
        confidence: 0.9,
        evidence: ["Task interface"]
      }
    ],
    semanticSummary,
    contractChanges: ["Task contract"],
    confidence: 0.8,
    source: "heuristic"
  };
}
