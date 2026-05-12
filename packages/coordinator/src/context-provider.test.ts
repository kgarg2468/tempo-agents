import { describe, expect, it } from "vitest";
import {
  DisabledExternalContextProvider,
  NativeTempoContextProvider
} from "./context-provider.js";
import { createTempoStore } from "./store.js";

describe("context providers", () => {
  it("serves native Tempo code and decision facts without external providers", async () => {
    const store = createTempoStore(":memory:");
    store.upsertFingerprint({
      id: "fp-1",
      repoId: "repo-1",
      worktreeId: "wt-a",
      diffHash: "hash-1",
      createdAt: 1778000000000,
      filesTouched: ["src/db/schema.ts"],
      symbols: { added: [], modified: ["Task"], removed: [] },
      surfaces: [
        {
          id: "task-model",
          label: "Task model",
          kind: "schema",
          files: ["src/db/schema.ts"],
          confidence: 0.8,
          evidence: ["schema path"]
        }
      ],
      semanticSummary: "Task model changed.",
      contractChanges: ["Task"],
      confidence: 0.8,
      source: "heuristic"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.8,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task.",
      primarySurface: "Task contract",
      affectedWorktreeIds: ["wt-a", "wt-b"],
      affectedSurfaces: ["Task model"],
      evidence: ["Both fingerprints touch Task model"],
      riskReasons: [],
      createdAt: 1778000000001,
      updatedAt: 1778000000001
    });
    store.upsertConflictDecision({
      id: "decision-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      selectedOptionId: "split",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Task model owner goes first.",
      createdBy: "dashboard",
      status: "active",
      createdAt: 1778000000002,
      updatedAt: 1778000000002
    });

    const result = await new NativeTempoContextProvider(store).query({
      repoId: "repo-1",
      worktreeId: "wt-a",
      surfaces: ["Task model"]
    });

    expect(result.enabled).toBe(true);
    expect(result.facts.map((fact) => fact.kind)).toEqual([
      "surface",
      "conflict",
      "decision"
    ]);
    store.close();
  });

  it("keeps external adapters disabled until the documented approval gate", async () => {
    const provider = new DisabledExternalContextProvider("nia");

    const result = await provider.query({ repoId: "repo-1" });

    expect(result.enabled).toBe(false);
    expect(result.facts).toEqual([]);
    expect(result.warnings[0]).toContain("ADR and Krish approval");
  });
});
