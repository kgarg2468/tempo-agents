import { describe, expect, it } from "vitest";
import { createHeuristicFingerprint } from "./fingerprint.js";

describe("heuristic fingerprinting", () => {
  it("turns a scoped schema diff into a live fingerprint", () => {
    const fingerprint = createHeuristicFingerprint({
      repoId: "repo-1",
      worktreeId: "wt-a",
      diffHash: "hash-a",
      files: [
        {
          path: "src/db/schema.ts",
          content: "export interface Task { id: string; priority: string }\n"
        }
      ],
      createdAt: 1778000000000
    });

    expect(fingerprint.filesTouched).toEqual(["src/db/schema.ts"]);
    expect(fingerprint.surfaces.map((surface) => surface.label)).toContain(
      "Task model"
    );
    expect(fingerprint.semanticSummary).toContain("Task model");
    expect(fingerprint.source).toBe("heuristic");
  });
});

