import { describe, expect, it } from "vitest";
import type { Fingerprint, RebaseConflict } from "@rebase/shared";
import {
  activeSessionConflict,
  surfaceLabelsForSessionGraph,
  targetSurfacesForFingerprint
} from "./session-graph";

const fingerprint: Fingerprint = {
  id: "fp-1",
  repoId: "repo-1",
  worktreeId: "wt-main",
  diffHash: "diff-1",
  createdAt: 1778000000000,
  filesTouched: ["src/shared/task.ts"],
  symbols: { added: [], modified: ["Task"], removed: [] },
  surfaces: [
    {
      id: "task-type",
      label: "Task type",
      kind: "type",
      files: ["src/shared/task.ts"],
      confidence: 0.8,
      evidence: ["type path"]
    }
  ],
  semanticSummary: "Task changed.",
  contractChanges: ["Task type"],
  confidence: 0.8,
  source: "heuristic"
};

const activeConflictFixture: RebaseConflict = {
  id: "conflict-1",
  repoId: "repo-1",
  status: "open",
  risk: "high",
  confidence: 0.8,
  type: "type",
  title: "Task contract overlap",
  summary: "Two worktrees touched Task contract.",
  primarySurface: "Task contract",
  affectedWorktreeIds: ["wt-main"],
  affectedSurfaces: ["Task type"],
  evidence: ["Both fingerprints touch Task type"],
  riskReasons: [],
  createdAt: 1778000000000,
  updatedAt: 1778000000000
};

describe("SessionMap graph", () => {
  it("does not render fingerprint surface nodes when there is no active conflict", () => {
    const activeConflict = activeSessionConflict([]);

    expect(
      surfaceLabelsForSessionGraph({
        fingerprints: [fingerprint],
        conflicts: []
      })
    ).toEqual([]);
    expect(targetSurfacesForFingerprint(fingerprint, activeConflict)).toEqual([]);
  });

  it("renders the primary surface when there is an active conflict", () => {
    const activeConflict = activeSessionConflict([activeConflictFixture]);

    expect(
      surfaceLabelsForSessionGraph({
        fingerprints: [fingerprint],
        conflicts: [activeConflictFixture]
      })
    ).toEqual(["Task contract"]);
    expect(targetSurfacesForFingerprint(fingerprint, activeConflict)).toEqual(
      ["Task contract"]
    );
  });
});
