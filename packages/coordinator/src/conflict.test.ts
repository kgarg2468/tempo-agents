import { describe, expect, it } from "vitest";
import { detectConflicts } from "./conflict.js";

const baseFingerprint = {
  repoId: "repo-1",
  createdAt: 1778000000000,
  symbols: {
    added: [],
    modified: [],
    removed: []
  },
  confidence: 0.8,
  source: "heuristic" as const
};

describe("conflict engine", () => {
  it("opens high risk when two worktrees touch the same schema contract surface", () => {
    const conflicts = detectConflicts([
      {
        ...baseFingerprint,
        id: "fp-a",
        worktreeId: "wt-a",
        diffHash: "a",
        filesTouched: ["src/db/schema.ts"],
        surfaces: [
          {
            id: "task-model",
            label: "Task model",
            kind: "schema",
            files: ["src/db/schema.ts"],
            confidence: 0.9,
            evidence: ["Task interface"]
          }
        ],
        semanticSummary: "Adds Task.priority.",
        contractChanges: ["Task.priority"]
      },
      {
        ...baseFingerprint,
        id: "fp-b",
        worktreeId: "wt-b",
        diffHash: "b",
        filesTouched: ["src/db/schema.ts"],
        surfaces: [
          {
            id: "task-model",
            label: "Task model",
            kind: "schema",
            files: ["src/db/schema.ts"],
            confidence: 0.9,
            evidence: ["Task interface"]
          }
        ],
        semanticSummary: "Adds Task.tags.",
        contractChanges: ["Task.tags"]
      }
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.risk).toBe("high");
    expect(conflicts[0]?.affectedSurfaces).toContain("Task model");
  });

  it("opens high risk and titles the shared Task contract before lower-level API handlers", () => {
    const conflicts = detectConflicts([
      {
        ...baseFingerprint,
        id: "fp-a",
        worktreeId: "wt-a",
        diffHash: "a",
        filesTouched: [
          "src/shared/task.ts",
          "src/app/api/tasks/[id]/route.ts"
        ],
        surfaces: [
          {
            id: "delete-api",
            label: "DELETE API",
            kind: "api",
            files: ["src/app/api/tasks/[id]/route.ts"],
            confidence: 0.7,
            evidence: ["route file"]
          },
          {
            id: "task-type",
            label: "Task type",
            kind: "type",
            files: ["src/shared/task.ts"],
            confidence: 0.9,
            evidence: ["Task interface"]
          }
        ],
        semanticSummary: "Adds Task.priority.",
        contractChanges: ["Task.priority"]
      },
      {
        ...baseFingerprint,
        id: "fp-b",
        worktreeId: "wt-b",
        diffHash: "b",
        filesTouched: [
          "src/shared/task.ts",
          "src/app/api/tasks/[id]/route.ts"
        ],
        surfaces: [
          {
            id: "delete-api",
            label: "DELETE API",
            kind: "api",
            files: ["src/app/api/tasks/[id]/route.ts"],
            confidence: 0.7,
            evidence: ["route file"]
          },
          {
            id: "task-type",
            label: "Task type",
            kind: "type",
            files: ["src/shared/task.ts"],
            confidence: 0.9,
            evidence: ["Task interface"]
          }
        ],
        semanticSummary: "Adds Task.dueDate.",
        contractChanges: ["Task.dueDate"]
      }
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.risk).toBe("high");
    expect(conflicts[0]?.primarySurface).toBe("Task contract");
    expect(conflicts[0]?.title).toBe("Task contract overlap");
    expect(conflicts[0]?.riskReasons[0]?.label).toBe("Shared contract root");
  });

  it("opens medium risk for shared component surfaces without escalating to high", () => {
    const conflicts = detectConflicts([
      {
        ...baseFingerprint,
        id: "fp-a",
        worktreeId: "wt-a",
        diffHash: "a",
        filesTouched: ["src/components/TaskCard.tsx"],
        surfaces: [
          {
            id: "task-card-props",
            label: "TaskCard props",
            kind: "component",
            files: ["src/components/TaskCard.tsx"],
            confidence: 0.78,
            evidence: ["component props"]
          }
        ],
        semanticSummary: "Shows priority on TaskCard.",
        contractChanges: ["TaskCard props"]
      },
      {
        ...baseFingerprint,
        id: "fp-b",
        worktreeId: "wt-b",
        diffHash: "b",
        filesTouched: ["src/components/TaskCard.tsx"],
        surfaces: [
          {
            id: "task-card-props",
            label: "TaskCard props",
            kind: "component",
            files: ["src/components/TaskCard.tsx"],
            confidence: 0.78,
            evidence: ["component props"]
          }
        ],
        semanticSummary: "Shows due date on TaskCard.",
        contractChanges: ["TaskCard props"]
      }
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.risk).toBe("medium");
    expect(conflicts[0]?.primarySurface).toBe("TaskCard props");
  });

  it("does not open medium/high risk for unrelated worktrees", () => {
    const conflicts = detectConflicts([
      {
        ...baseFingerprint,
        id: "fp-a",
        worktreeId: "wt-a",
        diffHash: "a",
        filesTouched: ["src/db/schema.ts"],
        surfaces: [
          {
            id: "task-model",
            label: "Task model",
            kind: "schema",
            files: ["src/db/schema.ts"],
            confidence: 0.9,
            evidence: ["Task interface"]
          }
        ],
        semanticSummary: "Adds Task.priority.",
        contractChanges: ["Task.priority"]
      },
      {
        ...baseFingerprint,
        id: "fp-b",
        worktreeId: "wt-b",
        diffHash: "b",
        filesTouched: ["src/utils/date.ts"],
        surfaces: [
          {
            id: "date-utils",
            label: "date utilities",
            kind: "utility",
            files: ["src/utils/date.ts"],
            confidence: 0.7,
            evidence: ["utils path"]
          }
        ],
        semanticSummary: "Adds formatRelativeDate.",
        contractChanges: []
      }
    ]);

    expect(conflicts).toEqual([]);
  });

  it("does not open a conflict when classifier says same-file overlap is harmless", () => {
    const conflicts = detectConflicts(
      [
        {
          ...baseFingerprint,
          id: "fp-a",
          worktreeId: "wt-a",
          diffHash: "a",
          filesTouched: ["src/file.ts"],
          surfaces: [],
          semanticSummary: "Adds an import.",
          contractChanges: []
        },
        {
          ...baseFingerprint,
          id: "fp-b",
          worktreeId: "wt-b",
          diffHash: "b",
          filesTouched: ["src/file.ts"],
          surfaces: [],
          semanticSummary: "Adds a debug print.",
          contractChanges: []
        }
      ],
      {
        classifications: new Map([
          [
            "wt-a:wt-b",
            {
              kind: "no_issue",
              rationale: "The edits touch unrelated lines and do not change contracts.",
              confidence: 0.9
            }
          ]
        ])
      }
    );

    expect(conflicts).toEqual([]);
  });

  it("opens a blocking conflict when classifier overrides low-signal local evidence", () => {
    const conflicts = detectConflicts(
      [
        {
          ...baseFingerprint,
          id: "fp-a",
          worktreeId: "wt-a",
          diffHash: "a",
          filesTouched: ["src/file.ts"],
          surfaces: [],
          semanticSummary: "Renames Task.title.",
          contractChanges: ["Task.title"]
        },
        {
          ...baseFingerprint,
          id: "fp-b",
          worktreeId: "wt-b",
          diffHash: "b",
          filesTouched: ["src/file.ts"],
          surfaces: [],
          semanticSummary: "Changes Task.title shape.",
          contractChanges: ["Task.title"]
        }
      ],
      {
        classifications: new Map([
          [
            "wt-a:wt-b",
            {
              kind: "blocking_conflict",
              rationale: "Both diffs change Task.title incompatibly.",
              source: "openai",
              confidence: 0.9
            }
          ]
        ])
      }
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.risk).toBe("high");
    expect(conflicts[0]?.classification?.kind).toBe("blocking_conflict");
  });

  it("opens a non-blocking coordination notice for additive-compatible contract overlap", () => {
    const conflicts = detectConflicts(
      [
        {
          ...baseFingerprint,
          id: "fp-a",
          worktreeId: "wt-a",
          diffHash: "a",
          filesTouched: ["src/shared/task.ts"],
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
          semanticSummary: "Adds Task.priority.",
          contractChanges: ["Task.priority"]
        },
        {
          ...baseFingerprint,
          id: "fp-b",
          worktreeId: "wt-b",
          diffHash: "b",
          filesTouched: ["src/shared/task.ts"],
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
          semanticSummary: "Adds Task.dueDate.",
          contractChanges: ["Task.dueDate"]
        }
      ],
      {
        classifications: new Map([
          [
            "wt-a:wt-b",
            {
              kind: "coordination_notice",
              rationale: "Both worktrees add independent Task fields.",
              recommendedOwnerWorktreeId: "wt-a",
              recommendedOptionId: "split-ownership",
              confidence: 0.86
            }
          ]
        ])
      }
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.risk).toBe("low");
    expect(conflicts[0]?.classification?.kind).toBe("coordination_notice");
    expect(conflicts[0]?.title).toBe("Task contract coordination notice");
  });
});
