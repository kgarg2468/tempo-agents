import { describe, expect, it } from "vitest";
import { runFixtureEvals } from "./index.js";

describe("fixture eval runner", () => {
  it("calculates recall and false positives from fixture fingerprints", () => {
    const result = runFixtureEvals([
      {
        id: "ts-task-conflict",
        language: "ts",
        expectedConflict: true,
        fingerprints: [
          {
            worktreeId: "a",
            filesTouched: ["src/db/schema.ts"],
            surfaces: ["Task model"]
          },
          {
            worktreeId: "b",
            filesTouched: ["src/db/schema.ts"],
            surfaces: ["Task model"]
          }
        ]
      },
      {
        id: "py-control",
        language: "py",
        expectedConflict: false,
        fingerprints: [
          {
            worktreeId: "a",
            filesTouched: ["app/models/task.py"],
            surfaces: ["Task model"]
          },
          {
            worktreeId: "b",
            filesTouched: ["app/utils/date.py"],
            surfaces: ["date utilities"]
          }
        ]
      }
    ]);

    expect(result.metrics.recall).toBe(1);
    expect(result.metrics.falsePositiveRate).toBe(0);
    expect(result.cases.map((item) => item.verdict)).toEqual(["true_positive", "true_negative"]);
  });
});

