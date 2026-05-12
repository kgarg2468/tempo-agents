import { z } from "zod";
import {
  conflictSchema,
  coordinationPlanSchema,
  coordinationEpisodeSchema,
  fingerprintSchema,
  mergeRiskAssessmentSchema,
  workOrderSchema
} from "@rebase/shared";
import type {
  CoordinationEpisode,
  CoordinationPlan,
  Fingerprint,
  RebaseConflict,
  WorkOrder
} from "@rebase/shared";
import type { RebasePipelineName } from "./rocketride.js";

export const fingerprintRunOutputSchema = z.object({
  fingerprint: fingerprintSchema
});

export const collisionRunOutputSchema = z.object({
  conflicts: z.array(conflictSchema),
  episodes: z.array(coordinationEpisodeSchema)
});

export const workOrderRunOutputSchema = z.object({
  episodes: z.array(coordinationEpisodeSchema),
  workOrders: z.array(workOrderSchema),
  coordinationPlan: coordinationPlanSchema.optional()
});

export const mergeRiskRunOutputSchema = z.object({
  mergeRisk: mergeRiskAssessmentSchema
});

export interface FingerprintRunOutput {
  fingerprint: Fingerprint;
}

export interface CollisionRunOutput {
  conflicts: RebaseConflict[];
  episodes: CoordinationEpisode[];
}

export interface WorkOrderRunOutput {
  episodes: CoordinationEpisode[];
  workOrders: WorkOrder[];
  coordinationPlan?: CoordinationPlan | undefined;
}

export type MergeRiskRunOutput = z.infer<typeof mergeRiskRunOutputSchema>;

export function parseFingerprintRunOutput(output: unknown): FingerprintRunOutput {
  return parseRocketRideOutput(
    output,
    fingerprintRunOutputSchema,
    "rebase-fingerprint"
  );
}

export function parseCollisionRunOutput(output: unknown): CollisionRunOutput {
  return parseRocketRideOutput(output, collisionRunOutputSchema, "rebase-collision");
}

export function parseWorkOrderRunOutput(output: unknown): WorkOrderRunOutput {
  return parseRocketRideOutput(output, workOrderRunOutputSchema, "rebase-work-order");
}

export function parseMergeRiskRunOutput(output: unknown): MergeRiskRunOutput {
  return parseRocketRideOutput(output, mergeRiskRunOutputSchema, "rebase-merge-risk");
}

export function parsePipelineRunOutput(
  name: RebasePipelineName,
  output: unknown
): FingerprintRunOutput | CollisionRunOutput | WorkOrderRunOutput | MergeRiskRunOutput {
  switch (name) {
    case "rebase-fingerprint":
      return parseFingerprintRunOutput(output);
    case "rebase-collision":
      return parseCollisionRunOutput(output);
    case "rebase-work-order":
      return parseWorkOrderRunOutput(output);
    case "rebase-merge-risk":
      return parseMergeRiskRunOutput(output);
  }
}

export function smokeInputForPipeline(name: RebasePipelineName): Record<string, unknown> {
  switch (name) {
    case "rebase-fingerprint":
      return {
        operation: "fingerprint",
        repoId: "smoke-repo",
        worktreeId: "smoke-worktree-a",
        diffHash: "smoke-diff-a",
        createdAt: 1778000000000,
        files: [
          {
            path: "src/shared/task.ts",
            content: "export interface Task { id: string; title: string; label: string; }"
          }
        ],
        diff: "diff --git a/src/shared/task.ts b/src/shared/task.ts"
      };
    case "rebase-collision":
      return {
        operation: "collision",
        fingerprints: [
          smokeFingerprint("smoke-fingerprint-a", "smoke-worktree-a"),
          smokeFingerprint("smoke-fingerprint-b", "smoke-worktree-b")
        ],
        plans: [
          smokeAgent("smoke-agent-a", "smoke-worktree-a"),
          smokeAgent("smoke-agent-b", "smoke-worktree-b")
        ],
        activeDecisions: []
      };
    case "rebase-work-order":
      return {
        operation: "work-order",
        conflicts: [smokeConflict()],
        episodes: [],
        agents: [
          smokeAgent("smoke-agent-a", "smoke-worktree-a"),
          smokeAgent("smoke-agent-b", "smoke-worktree-b")
        ],
        decisions: [],
        publications: [],
        existingWorkOrders: []
      };
    case "rebase-merge-risk":
      return {
        operation: "merge-risk",
        repoId: "smoke-repo",
        episode: {
          id: "smoke-episode",
          repoId: "smoke-repo",
          surface: "Task contract",
          status: "coordinating",
          risk: "high",
          confidence: 0.9,
          affectedWorktreeIds: ["smoke-worktree-a", "smoke-worktree-b"],
          affectedAgentSessionIds: ["smoke-agent-a", "smoke-agent-b"],
          conflictIds: ["smoke-conflict"],
          ownerAgentSessionId: "smoke-agent-a",
          rocketRideRunIds: [],
          createdAt: 1778000000000,
          updatedAt: 1778000000000
        },
        conflicts: [smokeConflict()],
        fingerprints: [
          smokeFingerprint("smoke-fingerprint-a", "smoke-worktree-a"),
          smokeFingerprint("smoke-fingerprint-b", "smoke-worktree-b")
        ],
        workOrders: [],
        diffs: [
          {
            worktreeId: "smoke-worktree-a",
            diffHash: "smoke-diff-a",
            diff: [
              "diff --git a/src/shared/task.ts b/src/shared/task.ts",
              "@@ -1,1 +1,1 @@",
              "-export interface Task { id: string }",
              "+export interface Task { id: string; label: string }"
            ].join("\n")
          },
          {
            worktreeId: "smoke-worktree-b",
            diffHash: "smoke-diff-b",
            diff: [
              "diff --git a/src/shared/task.ts b/src/shared/task.ts",
              "@@ -1,1 +1,1 @@",
              "-export interface Task { id: string }",
              "+export interface Task { id: string; subtitle: string | null }"
            ].join("\n")
          }
        ],
        createdAt: 1778000000000
      };
  }
}

function parseRocketRideOutput<T>(
  output: unknown,
  schema: z.ZodType<T>,
  pipelineName: RebasePipelineName
): T {
  for (const candidate of outputCandidates(output)) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  throw new Error(
    `RocketRide ${pipelineName} output did not match the required schema`
  );
}

function outputCandidates(output: unknown): unknown[] {
  const candidates: unknown[] = [];
  const queue: unknown[] = [output];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const value = queue.shift();
    if (value === undefined || seen.has(value)) continue;
    if (typeof value === "object" && value !== null) seen.add(value);

    const parsedString = parseJsonString(value);
    candidates.push(parsedString);

    if (Array.isArray(parsedString)) {
      queue.push(...parsedString);
      continue;
    }

    if (!isRecord(parsedString)) continue;
    for (const key of [
      "output",
      "result",
      "response",
      "data",
      "body",
      "text",
      "value"
    ]) {
      if (key in parsedString) queue.push(parsedString[key]);
    }
  }

  return candidates;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return value;
  }
}

function smokeFingerprint(id = "smoke-fingerprint", worktreeId = "smoke-worktree"): Fingerprint {
  return {
    id,
    repoId: "smoke-repo",
    worktreeId,
    diffHash: "smoke-diff",
    createdAt: 0,
    filesTouched: ["src/shared/task.ts"],
    symbols: {
      added: [],
      modified: ["Task"],
      removed: []
    },
    surfaces: [
      {
        id: "smoke-surface",
        label: "Task model",
        kind: "type",
        files: ["src/shared/task.ts"],
        confidence: 1,
        evidence: ["RocketRide smoke validation"]
      }
    ],
    semanticSummary: "RocketRide smoke fingerprint",
    contractChanges: ["Task model"],
    confidence: 1,
    source: "mixed"
  };
}

function smokeAgent(id: string, worktreeId: string) {
  return {
    id,
    repoId: "smoke-repo",
    worktreeId,
    agentKind: "codex",
    coordinationRole: "feature",
    cwd: `/tmp/${worktreeId}`,
    displayName: id,
    lastCheckpointAt: 1778000000000,
    joinedAt: 1778000000000
  };
}

function smokeConflict() {
  return {
    id: "smoke-conflict",
    repoId: "smoke-repo",
    status: "open",
    risk: "high",
    confidence: 0.9,
    type: "type",
    title: "Task contract overlap",
    summary: "Two worktrees are changing Task contract.",
    primarySurface: "Task contract",
    affectedWorktreeIds: ["smoke-worktree-a", "smoke-worktree-b"],
    affectedSurfaces: ["Task model"],
    evidence: ["File overlap: src/shared/task.ts"],
    riskReasons: [
      {
        label: "Shared contract root",
        detail: "Both worktrees touch Task contract surfaces.",
        weight: 90
      }
    ],
    createdAt: 1778000000000,
    updatedAt: 1778000000000
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
