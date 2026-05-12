import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createRebaseStore } from "./store.js";
import { createRebaseWatcher } from "./watcher.js";
import { worktreeIdFor } from "./ids.js";

async function createRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "rebase-watcher-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "rebase@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Rebase Test"], { cwd: dir });
  await mkdir(path.join(dir, "src", "db"), { recursive: true });
  await writeFile(
    path.join(dir, "src", "db", "schema.ts"),
    "export interface Task { id: string }\n"
  );
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("RebaseWatcher", () => {
  it("discovers worktrees and persists fingerprints/conflicts from a scan", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-watch-a-${path.basename(repo)}`);
    const wtB = path.join(path.dirname(repo), `rebase-watch-b-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });
    await execa("git", ["worktree", "add", "-b", "agent-b", wtB], { cwd: repo });
    await writeFile(
      path.join(wtA, "src", "db", "schema.ts"),
      "export interface Task { id: string; priority: string }\n"
    );
    await writeFile(
      path.join(wtB, "src", "db", "schema.ts"),
      "export interface Task { id: string; tags: string[] }\n"
    );

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.scanOnce();

    expect(store.listWorktrees("repo-1")).toHaveLength(3);
    expect(store.listFingerprints("repo-1")).toHaveLength(2);
    expect(store.listConflicts("repo-1")[0]?.affectedSurfaces).toContain(
      "Task model"
    );
    expect(store.listAdvisories("repo-1")[0]?.options[0]?.title).toBe(
      "Agree contract first"
    );
    expect(store.listEvents("repo-1").map((event) => event.type)).toContain(
      "analysis.completed"
    );

    await watcher.stop();
    store.close();
  });

  it("runs RocketRide pipelines during analysis and stores run ids on coordination episodes", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-watch-a-${path.basename(repo)}`);
    const wtB = path.join(path.dirname(repo), `rebase-watch-b-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });
    await execa("git", ["worktree", "add", "-b", "agent-b", wtB], { cwd: repo });
    await writeFile(
      path.join(wtA, "src", "db", "schema.ts"),
      "export interface Task { id: string; label: string }\n"
    );
    await writeFile(
      path.join(wtB, "src", "db", "schema.ts"),
      "export interface Task { id: string; subtitle: string | null }\n"
    );
    const realWtA = await realpath(wtA);
    const realWtB = await realpath(wtB);
    const calls: string[] = [];

    const store = createRebaseStore(":memory:");
    store.upsertAgentSession({
      id: "agent-a",
      repoId: "repo-1",
      worktreeId: worktreeIdFor(realWtA),
      agentKind: "codex",
      coordinationRole: "feature",
      cwd: realWtA,
      displayName: "agent-a",
      lastCheckpointAt: 1778000000000,
      joinedAt: 1778000000000
    });
    store.upsertAgentSession({
      id: "agent-b",
      repoId: "repo-1",
      worktreeId: worktreeIdFor(realWtB),
      agentKind: "codex",
      coordinationRole: "feature",
      cwd: realWtB,
      displayName: "agent-b",
      lastCheckpointAt: 1778000000000,
      joinedAt: 1778000000001
    });
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000,
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide test runner"
        }),
        async runPipeline(name: string, input: Record<string, unknown>) {
          calls.push(name);
          const runId = `rr-${name}-${calls.length}`;
          if (name === "rebase-fingerprint") {
            return {
              runId,
              output: { fingerprint: fingerprintFromInput(input) }
            };
          }
          if (name === "rebase-collision") {
            return {
              runId,
              output: {
                conflicts: [rocketRideConflict(worktreeIdFor(realWtA), worktreeIdFor(realWtB))],
                episodes: []
              }
            };
          }
          if (name === "rebase-work-order") {
            return {
              runId,
              output: {
                episodes: [
                  rocketRideEpisode(worktreeIdFor(realWtA), worktreeIdFor(realWtB), [
                    "rr-rebase-collision-3",
                    runId
                  ])
                ],
                workOrders: [
                  rocketRideWorkOrder("agent-a", "contract_owner"),
                  rocketRideWorkOrder("agent-b", "adapter")
                ]
              }
            };
          }
          return {
            runId,
            output: {
              mergeRisk: rocketRideMergeRisk({
                episodeId: "rr-episode-task",
                runId,
                leftWorktreeId: worktreeIdFor(realWtA),
                rightWorktreeId: worktreeIdFor(realWtB)
              })
            }
          };
        }
      }
    });

    await watcher.scanOnce();

    expect(calls).toEqual(
      expect.arrayContaining([
        "rebase-fingerprint",
        "rebase-collision",
        "rebase-work-order",
        "rebase-merge-risk"
      ])
    );
    expect(store.listCoordinationEpisodes("repo-1")[0]?.rocketRideRunIds).toEqual(
      expect.arrayContaining([
        "rr-rebase-collision-3",
        "rr-rebase-work-order-4",
        "rr-rebase-merge-risk-5"
      ])
    );
    expect(store.listCoordinationEpisodes("repo-1")[0]?.status).toBe("blocked");
    expect(store.listCoordinationEpisodes("repo-1")[0]?.ownerAgentSessionId).toBeUndefined();
    expect(store.listMergeRiskAssessments("repo-1")[0]).toMatchObject({
      status: "blocked",
      rocketRideRunId: "rr-rebase-merge-risk-5"
    });
    expect(store.listConflicts("repo-1")[0]?.summary).toBe(
      "RocketRide found a Task contract overlap."
    );
    expect(store.listWorkOrders("repo-1")).toHaveLength(2);
    expect(store.listWorkOrders("repo-1").map((workOrder) => workOrder.status)).toEqual([
      "superseded",
      "superseded"
    ]);

    await watcher.stop();
    store.close();
  });

  it("marks an episode safe from authoritative RocketRide merge-risk output", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-watch-a-${path.basename(repo)}`);
    const wtB = path.join(path.dirname(repo), `rebase-watch-b-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });
    await execa("git", ["worktree", "add", "-b", "agent-b", wtB], { cwd: repo });
    await writeFile(
      path.join(wtA, "src", "db", "schema.ts"),
      "export interface Task { id: string; label: string }\n"
    );
    await writeFile(
      path.join(wtB, "src", "db", "schema.ts"),
      "export interface Task { id: string; label: string }\n"
    );
    const realWtA = await realpath(wtA);
    const realWtB = await realpath(wtB);
    const leftWorktreeId = worktreeIdFor(realWtA);
    const rightWorktreeId = worktreeIdFor(realWtB);
    const store = createRebaseStore(":memory:");
    for (const [id, worktreeId, cwd, joinedAt] of [
      ["agent-a", leftWorktreeId, realWtA, 1778000000000] as const,
      ["agent-b", rightWorktreeId, realWtB, 1778000000001] as const
    ]) {
      store.upsertAgentSession({
        id,
        repoId: "repo-1",
        worktreeId,
        agentKind: "codex",
        coordinationRole: "feature",
        cwd,
        displayName: id,
        lastCheckpointAt: 1778000000000,
        joinedAt
      });
    }
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000,
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide test runner"
        }),
        async runPipeline(name: string, input: Record<string, unknown>) {
          const runId = `rr-${name}`;
          if (name === "rebase-fingerprint") {
            return { runId, output: { fingerprint: fingerprintFromInput(input) } };
          }
          if (name === "rebase-collision") {
            return {
              runId,
              output: {
                conflicts: [rocketRideConflict(leftWorktreeId, rightWorktreeId)],
                episodes: []
              }
            };
          }
          if (name === "rebase-work-order") {
            return {
              runId,
              output: {
                episodes: [rocketRideEpisode(leftWorktreeId, rightWorktreeId, [runId])],
                workOrders: [
                  { ...rocketRideWorkOrder("agent-a", "contract_owner"), status: "completed" },
                  { ...rocketRideWorkOrder("agent-b", "adapter"), status: "completed" }
                ]
              }
            };
          }
          return {
            runId,
            output: {
              mergeRisk: {
                id: "rr-merge-risk-safe",
                repoId: "repo-1",
                episodeId: "rr-episode-task",
                status: "safe",
                risk: "low",
                safe: true,
                diffHash: "aligned-diff",
                rocketRideRunId: runId,
                predictedConflicts: [],
                warnings: [],
                requiredWorkOrders: [],
                evidence: [],
                createdAt: 1778000000000
              }
            }
          };
        }
      }
    });

    await watcher.scanOnce();

    expect(store.listCoordinationEpisodes("repo-1")[0]?.status).toBe("safe");
    expect(store.listConflicts("repo-1")[0]?.status).toBe("resolved");

    await watcher.stop();
    store.close();
  });

  it("marks removed git worktrees as missing on refresh", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-watch-a-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.refreshWorktrees();
    await execa("git", ["worktree", "remove", wtA], { cwd: repo });
    await watcher.refreshWorktrees();

    const removed = store
      .listWorktrees("repo-1")
      .find((worktree) => worktree.branch === "agent-a");
    expect(removed?.status).toBe("missing");

    await watcher.stop();
    store.close();
  });

  it("does not emit repeated activity events for unchanged dirty worktrees", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "src", "db", "schema.ts"),
      "export interface Task { id: string; priority: string }\n"
    );

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.refreshWorktrees();
    await watcher.refreshWorktrees();

    expect(
      store
        .listEvents("repo-1")
        .filter((event) => event.type === "worktree.activity")
    ).toHaveLength(1);

    await watcher.stop();
    store.close();
  });

  it("ignores generated and Rebase-private paths", () => {
    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: "/tmp/repo",
      repoId: "repo-1",
      store
    });

    expect(watcher.isIgnoredPath("/tmp/repo/.rebase/runtime.json")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/node_modules/pkg/index.js")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/next-env.d.ts")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/tsconfig.tsbuildinfo")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/data/todo.sqlite-wal")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/pnpm-debug.log")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/src/schema.ts")).toBe(false);
    store.close();
  });

  it("treats ignored-only diffs as clean worktrees", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "next-env.d.ts"),
      "import \"./.next/types/routes.d.ts\";\n"
    );
    await execa("git", ["add", "next-env.d.ts"], { cwd: repo });
    await execa("git", ["commit", "-m", "add next env"], { cwd: repo });
    await writeFile(
      path.join(repo, "next-env.d.ts"),
      "import \"./.next/dev/types/routes.d.ts\";\n"
    );

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.refreshWorktrees();

    expect(store.listWorktrees("repo-1")[0]?.dirty).toBe(false);

    await watcher.stop();
    store.close();
  });
});

function fingerprintFromInput(input: Record<string, unknown>) {
  return {
    id: `rr-${String(input.worktreeId)}`,
    repoId: String(input.repoId),
    worktreeId: String(input.worktreeId),
    diffHash: String(input.diffHash),
    createdAt: 1778000000000,
    filesTouched: ["src/db/schema.ts"],
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
        files: ["src/db/schema.ts"],
        confidence: 0.9,
        evidence: ["RocketRide detected Task contract"]
      }
    ],
    semanticSummary: "RocketRide authoritative fingerprint",
    contractChanges: ["Task contract changed"],
    confidence: 0.9,
    source: "mixed"
  };
}

function rocketRideConflict(leftWorktreeId: string, rightWorktreeId: string) {
  return {
    id: "rr-conflict-task",
    repoId: "repo-1",
    status: "open",
    risk: "high",
    confidence: 0.9,
    type: "type",
    title: "Task contract overlap",
    summary: "RocketRide found a Task contract overlap.",
    primarySurface: "Task model",
    affectedWorktreeIds: [leftWorktreeId, rightWorktreeId],
    affectedSurfaces: ["Task model"],
    evidence: ["RocketRide grouped the Task surface"],
    riskReasons: [],
    createdAt: 1778000000000,
    updatedAt: 1778000000000
  };
}

function rocketRideEpisode(
  leftWorktreeId: string,
  rightWorktreeId: string,
  rocketRideRunIds: string[]
) {
  return {
    id: "rr-episode-task",
    repoId: "repo-1",
    surface: "Task model",
    status: "coordinating",
    risk: "high",
    confidence: 0.9,
    affectedWorktreeIds: [leftWorktreeId, rightWorktreeId],
    affectedAgentSessionIds: ["agent-a", "agent-b"],
    conflictIds: ["rr-conflict-task"],
    ownerAgentSessionId: "agent-a",
    rocketRideRunIds,
    createdAt: 1778000000000,
    updatedAt: 1778000000000
  };
}

function rocketRideMergeRisk(input: {
  episodeId: string;
  runId: string;
  leftWorktreeId: string;
  rightWorktreeId: string;
}) {
  return {
    id: "rr-merge-risk-task",
    repoId: "repo-1",
    episodeId: input.episodeId,
    status: "blocked",
    risk: "high",
    safe: false,
    diffHash: "diff-a+diff-b",
    rocketRideRunId: input.runId,
    predictedConflicts: [
      {
        id: "predicted-1",
        risk: "high",
        reasonCode: "same_hunk",
        summary: "Two worktrees edit the same Task hunk.",
        files: ["src/db/schema.ts"],
        symbols: ["Task"],
        affectedWorktreeIds: [input.leftWorktreeId, input.rightWorktreeId],
        evidence: ["Overlapping hunks in src/db/schema.ts"],
        blocking: true
      }
    ],
    warnings: [],
    requiredWorkOrders: ["rr-work-order-agent-b"],
    evidence: [
      {
        label: "Shared hunk",
        detail: "Both worktrees edit src/db/schema.ts.",
        files: ["src/db/schema.ts"],
        worktreeIds: [input.leftWorktreeId, input.rightWorktreeId]
      }
    ],
    createdAt: 1778000000000
  };
}

function rocketRideWorkOrder(
  agentSessionId: string,
  role: "contract_owner" | "adapter"
) {
  return {
    id: `rr-work-order-${agentSessionId}`,
    repoId: "repo-1",
    episodeId: "rr-episode-task",
    agentSessionId,
    role,
    status: "queued",
    revision: 1,
    title: `${role} work order`,
    summary: "RocketRide assigned the Task contract work.",
    requiredContract: "Task must include label and subtitle.",
    allowedFiles: ["src/shared/task.ts"],
    blockedFiles: [],
    sharedFiles: ["src/shared/task.ts"],
    nextCheckpoint: "Publish the combined Task contract.",
    createdAt: 1778000000000,
    updatedAt: 1778000000000
  };
}
