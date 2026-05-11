import { describe, expect, it } from "vitest";
import {
  parseCollisionRunOutput,
  parseFingerprintRunOutput,
  parseMergeRiskRunOutput,
  parseWorkOrderRunOutput,
  smokeInputForPipeline
} from "./rocketride-contracts.js";

describe("RocketRide typed output contracts", () => {
  it("parses a fingerprint returned directly by RocketRide", () => {
    const output = parseFingerprintRunOutput({
      fingerprint: fingerprint("fp-1", "wt-a")
    });

    expect(output.fingerprint.semanticSummary).toBe("RocketRide fingerprint");
  });

  it("parses JSON embedded in a RocketRide response text field", () => {
    const output = parseCollisionRunOutput({
      response: JSON.stringify({
        conflicts: [conflict("conflict-1")],
        episodes: [episode("episode-1", ["rr-collision"])]
      })
    });

    expect(output.conflicts[0]?.id).toBe("conflict-1");
    expect(output.episodes[0]?.rocketRideRunIds).toEqual(["rr-collision"]);
  });

  it("rejects invalid required outputs instead of accepting opaque responses", () => {
    expect(() => parseWorkOrderRunOutput({ ok: true })).toThrow(
      "RocketRide rebase-work-order output did not match the required schema"
    );
  });

  it("uses raw smoke inputs that must be transformed by RocketRide", () => {
    expect(() =>
      parseFingerprintRunOutput(smokeInputForPipeline("rebase-fingerprint"))
    ).toThrow("RocketRide rebase-fingerprint output did not match");
    expect(() =>
      parseCollisionRunOutput(smokeInputForPipeline("rebase-collision"))
    ).toThrow("RocketRide rebase-collision output did not match");
    expect(() =>
      parseWorkOrderRunOutput(smokeInputForPipeline("rebase-work-order"))
    ).toThrow("RocketRide rebase-work-order output did not match");
    expect(() =>
      parseMergeRiskRunOutput(smokeInputForPipeline("rebase-merge-risk"))
    ).toThrow("RocketRide rebase-merge-risk output did not match");
  });

  it("rejects live RocketRide metadata-only responses", () => {
    expect(() =>
      parseFingerprintRunOutput({
        name: "rebase-fingerprint.input.json",
        path: "",
        objectId: "metadata-only"
      })
    ).toThrow("RocketRide rebase-fingerprint output did not match");
  });

  it("parses predictive merge-risk output with evidence and blocking work orders", () => {
    const output = parseMergeRiskRunOutput({
      response: JSON.stringify({
        mergeRisk: mergeRisk("merge-risk-1")
      })
    });

    expect(output.mergeRisk.status).toBe("blocked");
    expect(output.mergeRisk.predictedConflicts[0]?.reasonCode).toBe("same_hunk");
    expect(output.mergeRisk.requiredWorkOrders).toEqual(["work-order-agent-b-r1"]);
  });

  it("rejects the old merge-risk placeholder shape", () => {
    expect(() =>
      parseMergeRiskRunOutput({
        mergeRisk: {
          safe: true,
          gitConflicts: [],
          failedChecks: [],
          requiredWorkOrders: []
        }
      })
    ).toThrow("RocketRide rebase-merge-risk output did not match");
  });
});

function fingerprint(id: string, worktreeId: string) {
  return {
    id,
    repoId: "repo-1",
    worktreeId,
    diffHash: "diff-1",
    createdAt: 1778000000000,
    filesTouched: ["src/shared/task.ts"],
    symbols: {
      added: ["Task.label"],
      modified: ["Task"],
      removed: []
    },
    surfaces: [
      {
        id: "surface-task",
        label: "Task model",
        kind: "type",
        files: ["src/shared/task.ts"],
        confidence: 0.9,
        evidence: ["Task type changed"]
      }
    ],
    semanticSummary: "RocketRide fingerprint",
    contractChanges: ["Task model changed"],
    confidence: 0.9,
    source: "mixed"
  };
}

function conflict(id: string) {
  return {
    id,
    repoId: "repo-1",
    status: "open",
    risk: "high",
    confidence: 0.9,
    type: "type",
    title: "Task contract overlap",
    summary: "RocketRide found a Task contract overlap.",
    primarySurface: "Task model",
    affectedWorktreeIds: ["wt-a", "wt-b"],
    affectedSurfaces: ["Task model"],
    evidence: ["Both worktrees changed Task"],
    riskReasons: [],
    createdAt: 1778000000000,
    updatedAt: 1778000000000
  };
}

function episode(id: string, rocketRideRunIds: string[]) {
  return {
    id,
    repoId: "repo-1",
    surface: "Task model",
    status: "coordinating",
    risk: "high",
    confidence: 0.9,
    affectedWorktreeIds: ["wt-a", "wt-b"],
    affectedAgentSessionIds: ["agent-a", "agent-b"],
    conflictIds: ["conflict-1"],
    ownerAgentSessionId: "agent-a",
    rocketRideRunIds,
    createdAt: 1778000000000,
    updatedAt: 1778000000000
  };
}

function mergeRisk(id: string) {
  return {
    id,
    repoId: "repo-1",
    episodeId: "episode-1",
    status: "blocked",
    risk: "high",
    safe: false,
    diffHash: "diff-a+diff-b",
    predictedConflicts: [
      {
        id: "predicted-1",
        risk: "high",
        reasonCode: "same_hunk",
        summary: "Two worktrees edit the same Task hunk.",
        files: ["src/shared/task.ts"],
        symbols: ["Task"],
        affectedWorktreeIds: ["wt-a", "wt-b"],
        evidence: ["Overlapping hunks in src/shared/task.ts"],
        blocking: true
      }
    ],
    warnings: [],
    requiredWorkOrders: ["work-order-agent-b-r1"],
    evidence: [
      {
        label: "Shared hunk",
        detail: "Both worktrees edit src/shared/task.ts near line 1.",
        files: ["src/shared/task.ts"],
        worktreeIds: ["wt-a", "wt-b"]
      }
    ],
    createdAt: 1778000000000
  };
}
