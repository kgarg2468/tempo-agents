import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Fingerprint, TempoConflict } from "@tempo/shared";
import {
  extractChangedFilesFromDiff,
  getWorktreeDiff,
  hashNormalizedDiff,
  listWorktrees,
  normalizeDiff
} from "./git.js";
import { classificationKey, detectConflicts } from "./conflict.js";
import { createCompatibilityClassification } from "./compatibility.js";
import { worktreeIdFor } from "./ids.js";
import { createStructuredFingerprint } from "./openai-fingerprint.js";
import { parseFingerprintRunOutput } from "./rocketride-contracts.js";
import { createTempoPathFilter } from "./path-ignore.js";
import {
  isRocketRideRequired,
  runRocketRidePipeline,
  type RocketRideCoordinator
} from "./rocketride.js";

export interface AnalyzeWorktreesInput {
  repoRoot: string;
  repoId: string;
  rocketRide?: RocketRideCoordinator | undefined;
}

export interface AnalyzeWorktreesResult {
  fingerprints: Fingerprint[];
  conflicts: TempoConflict[];
  rocketRideRunIds: string[];
}

export async function analyzeWorktreesOnce(
  input: AnalyzeWorktreesInput
): Promise<AnalyzeWorktreesResult> {
  const worktrees = await listWorktrees(input.repoRoot);
  const fingerprints: Fingerprint[] = [];
  const diffsByWorktreeId = new Map<string, string>();
  const pathFilter = createTempoPathFilter(input.repoRoot);
  const rocketRideRunIds: string[] = [];
  const rocketRideRequired = isRocketRideRequired(input.rocketRide);

  for (const worktree of worktrees) {
    const diff = await getWorktreeDiff(worktree.path);
    const filteredDiff = pathFilter.filterDiff(diff);
    const normalized = normalizeDiff(filteredDiff);
    if (!normalized) continue;
    const worktreeId = worktreeIdFor(worktree.path);
    diffsByWorktreeId.set(worktreeId, filteredDiff);

    const changedFiles = extractChangedFilesFromDiff(filteredDiff);
    const snapshots = await Promise.all(
      changedFiles.map(async (filePath) => ({
        path: filePath,
        content: await readFileContent(path.join(worktree.path, filePath))
      }))
    );

    const fingerprintInput = {
      repoId: input.repoId,
      worktreeId,
      diffHash: hashNormalizedDiff(normalized),
      createdAt: Date.now(),
      files: snapshots,
      diff: filteredDiff
    };
    const rocketRideRun = await runRocketRidePipeline(
      input.rocketRide,
      "tempo-fingerprint",
      {
        ...fingerprintInput,
        repoRoot: input.repoRoot,
        worktree,
        hookEvidence: [],
        graphFacts: []
      }
    );
    if (rocketRideRun) {
      rocketRideRunIds.push(rocketRideRun.runId);
      if (rocketRideRequired) {
        fingerprints.push(parseFingerprintRunOutput(rocketRideRun.output).fingerprint);
        continue;
      }
    }

    fingerprints.push(await createStructuredFingerprint(fingerprintInput));
  }
  if (rocketRideRequired) {
    return {
      fingerprints,
      conflicts: [],
      rocketRideRunIds
    };
  }

  const classifications = await classifyFingerprintPairs(
    fingerprints,
    diffsByWorktreeId
  );

  return {
    fingerprints,
    conflicts: detectConflicts(fingerprints, { classifications }),
    rocketRideRunIds
  };
}

async function classifyFingerprintPairs(
  fingerprints: Fingerprint[],
  diffsByWorktreeId: Map<string, string>
) {
  const classifications = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof createCompatibilityClassification>>>
  >();
  const sorted = [...fingerprints].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i];
      const right = sorted[j];
      if (!left || !right || left.worktreeId === right.worktreeId) continue;
      const classification = await createCompatibilityClassification({
        left,
        right,
        leftDiff: diffsByWorktreeId.get(left.worktreeId) ?? "",
        rightDiff: diffsByWorktreeId.get(right.worktreeId) ?? ""
      });
      if (classification) {
        classifications.set(
          classificationKey(left.worktreeId, right.worktreeId),
          classification
        );
      }
    }
  }
  return classifications;
}

async function readFileContent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}
