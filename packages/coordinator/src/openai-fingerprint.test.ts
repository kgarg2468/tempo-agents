import { describe, expect, it } from "vitest";
import { createStructuredFingerprint } from "./openai-fingerprint.js";

const files = [
  {
    path: "src/db/schema.ts",
    content: "export interface Task { id: string; priority: string }\n"
  }
];

describe("OpenAI fingerprint pipeline", () => {
  it("uses heuristic fingerprints when no model invoker or API key is configured", async () => {
    const fingerprint = await createStructuredFingerprint(
      {
        repoId: "repo-1",
        worktreeId: "wt-1",
        diffHash: "hash-1",
        files,
        diff: "diff --git a/src/db/schema.ts b/src/db/schema.ts"
      },
      {
        env: {}
      }
    );

    expect(fingerprint.source).toBe("heuristic");
    expect(fingerprint.surfaces[0]?.label).toBe("Task model");
  });

  it("enriches and caches valid model output by diff hash", async () => {
    let calls = 0;
    const cache = new Map();

    const first = await createStructuredFingerprint(
      {
        repoId: "repo-1",
        worktreeId: "wt-1",
        diffHash: "hash-1",
        files,
        diff: "diff --git a/src/db/schema.ts b/src/db/schema.ts"
      },
      {
        cache,
        modelInvoker: async () => {
          calls += 1;
          return {
            semanticSummary: "Adds priority to Task.",
            likelyContractChanges: ["Task model"],
            confidence: 0.91
          };
        }
      }
    );
    const second = await createStructuredFingerprint(
      {
        repoId: "repo-1",
        worktreeId: "wt-1",
        diffHash: "hash-1",
        files,
        diff: "diff --git a/src/db/schema.ts b/src/db/schema.ts"
      },
      {
        cache,
        modelInvoker: async () => {
          calls += 1;
          return {
            semanticSummary: "Should not be called.",
            likelyContractChanges: [],
            confidence: 0.1
          };
        }
      }
    );

    expect(calls).toBe(1);
    expect(first.source).toBe("mixed");
    expect(first.semanticSummary).toBe("Adds priority to Task.");
    expect(second.semanticSummary).toBe("Adds priority to Task.");
  });

  it("rejects invalid model output and keeps heuristic analysis", async () => {
    const fingerprint = await createStructuredFingerprint(
      {
        repoId: "repo-1",
        worktreeId: "wt-1",
        diffHash: "hash-1",
        files,
        diff: "diff --git a/src/db/schema.ts b/src/db/schema.ts"
      },
      {
        modelInvoker: async () => ({
          semanticSummary: "",
          likelyContractChanges: ["Task model"],
          confidence: 10
        })
      }
    );

    expect(fingerprint.source).toBe("heuristic");
    expect(fingerprint.semanticSummary).toContain("Task model");
  });
});
