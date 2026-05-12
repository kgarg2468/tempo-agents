import { describe, expect, it } from "vitest";
import type { Fingerprint } from "@tempo/shared";
import { createCompatibilityClassification } from "./compatibility.js";

describe("compatibility classifier", () => {
  it("uses model output to classify additive contract overlap as a notice", async () => {
    const classification = await createCompatibilityClassification(
      {
        left: fingerprint("wt-priority", "Adds Task.priority."),
        right: fingerprint("wt-due", "Adds Task.dueDate."),
        leftDiff: "diff --git a/src/shared/task.ts b/src/shared/task.ts\n+ priority: TaskPriority\n",
        rightDiff: "diff --git a/src/shared/task.ts b/src/shared/task.ts\n+ dueDate: string\n"
      },
      {
        modelInvoker: async () => ({
          kind: "coordination_notice",
          rationale: "Both worktrees add independent required Task fields.",
          recommendedOwnerWorktreeId: "wt-priority",
          recommendedOptionId: "split-ownership",
          confidence: 0.86
        })
      }
    );

    expect(classification?.kind).toBe("coordination_notice");
    expect(classification?.recommendedOwnerWorktreeId).toBe("wt-priority");
    expect(classification?.source).toBe("openai");
  });

  it("uses model output to classify destructive overlap as blocking", async () => {
    const classification = await createCompatibilityClassification(
      {
        left: fingerprint("wt-a", "Renames Task.title to Task.name."),
        right: fingerprint("wt-b", "Changes Task.title validation."),
        leftDiff: "- title: string\n+ name: string\n",
        rightDiff: "+ title: NonEmptyString\n"
      },
      {
        modelInvoker: async () => ({
          kind: "blocking_conflict",
          rationale: "Both worktrees change the same Task title contract.",
          recommendedOwnerWorktreeId: "wt-a",
          recommendedOptionId: "split-ownership",
          confidence: 0.91
        })
      }
    );

    expect(classification?.kind).toBe("blocking_conflict");
    expect(classification?.source).toBe("openai");
  });

  it("falls back to a coordination notice when model classification fails for independent additions", async () => {
    const classification = await createCompatibilityClassification(
      {
        left: fingerprint("wt-a", "Adds Task.priority."),
        right: fingerprint("wt-b", "Adds Task.dueDate."),
        leftDiff: "+ priority: string\n",
        rightDiff: "+ dueDate: string\n"
      },
      {
        modelInvoker: async () => {
          throw new Error("model unavailable");
        }
      }
    );

    expect(classification?.kind).toBe("coordination_notice");
    expect(classification?.source).toBe("fallback");
  });

  it("falls back to blocking when model classification fails for destructive contract edits", async () => {
    const classification = await createCompatibilityClassification(
      {
        left: fingerprint("wt-a", "Renames Task.title to Task.label."),
        right: fingerprint("wt-b", "Changes Task.title into an object."),
        leftDiff: "- title: string\n+ label: string\n",
        rightDiff: "- title: string\n+ title: { text: string; subtitle: string }\n"
      },
      {
        modelInvoker: async () => {
          throw new Error("model unavailable");
        }
      }
    );

    expect(classification?.kind).toBe("blocking_conflict");
    expect(classification?.source).toBe("fallback");
  });
});

function fingerprint(worktreeId: string, semanticSummary: string): Fingerprint {
  return {
    id: `fp-${worktreeId}`,
    repoId: "repo-1",
    worktreeId,
    diffHash: `hash-${worktreeId}`,
    createdAt: 1778000000000,
    filesTouched: ["src/shared/task.ts"],
    symbols: {
      added: [],
      modified: ["Task"],
      removed: []
    },
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
