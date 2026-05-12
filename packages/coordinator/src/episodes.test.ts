import type { AgentSession, TempoConflict } from "@tempo/shared";
import { describe, expect, it } from "vitest";
import { buildCoordinationEpisodes } from "./episodes.js";
import { stableId } from "./ids.js";

const now = 1778000000000;

describe("coordination episodes", () => {
  it("groups blocking conflicts without assigning an owner before a decision", () => {
    const agents = [
      makeAgent("agent-a", "wt-a", 1),
      makeAgent("agent-b", "wt-b", 2),
      makeAgent("agent-c", "wt-c", 3)
    ];
    const conflicts = [
      makeConflict("conflict-ab", ["wt-a", "wt-b"]),
      makeConflict("conflict-bc", ["wt-b", "wt-c"]),
      makeConflict("conflict-ac", ["wt-a", "wt-c"])
    ];

    const plan = buildCoordinationEpisodes({
      repoId: "repo-1",
      conflicts,
      agents,
      decisions: [],
      publications: [],
      createdAt: now
    });

    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0]).toMatchObject({
      repoId: "repo-1",
      surface: "Task contract",
      risk: "high",
      status: "coordinating",
      affectedWorktreeIds: ["wt-a", "wt-b", "wt-c"],
      affectedAgentSessionIds: ["agent-a", "agent-b", "agent-c"],
      conflictIds: ["conflict-ab", "conflict-ac", "conflict-bc"],
    });
    expect(plan.episodes[0]?.ownerAgentSessionId).toBeUndefined();
    expect(plan.workOrders).toEqual([]);
  });

  it("uses active split-ownership decisions and owner publications as the merge contract", () => {
    const agents = [
      makeAgent("agent-a", "wt-a", 1),
      makeAgent("agent-b", "wt-b", 2),
      makeAgent("agent-c", "wt-c", 3)
    ];

    const plan = buildCoordinationEpisodes({
      repoId: "repo-1",
      conflicts: [
        makeConflict("conflict-ab", ["wt-a", "wt-b"]),
        makeConflict("conflict-bc", ["wt-b", "wt-c"])
      ],
      agents,
      decisions: [
        {
          id: "decision-1",
          repoId: "repo-1",
          conflictId: "conflict-ab",
          selectedOptionId: "split-ownership",
          selectedOptionTitle: "Split ownership",
          selectedOptionDirection: "Agent B owns Task contract.",
          ownerAgentSessionId: "agent-b",
          createdBy: "agent",
          status: "active",
          createdAt: now,
          updatedAt: now
        }
      ],
      publications: [
        {
          id: "publication-1",
          repoId: "repo-1",
          conflictId: "conflict-ab",
          ownerAgentSessionId: "agent-b",
          surface: "Task contract",
          shapeSummary: "Task keeps title:string and adds label plus project.",
          files: ["src/shared/task.ts", "src/db/schema.ts"],
          createdAt: now + 1
        }
      ],
      createdAt: now + 2
    });

    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0]?.ownerAgentSessionId).toBe("agent-b");
    expect(plan.episodes[0]?.mergeContract).toMatchObject({
      ownerAgentSessionId: "agent-b",
      summary: "Task keeps title:string and adds label plus project.",
      files: ["src/shared/task.ts", "src/db/schema.ts"]
    });
    expect(
      plan.workOrders.find((order) => order.agentSessionId === "agent-b")?.role
    ).toBe("contract_owner");
    expect(
      plan.workOrders.find((order) => order.agentSessionId === "agent-a")?.requiredContract
    ).toContain("Task keeps title:string");
    expect(
      plan.workOrders.find((order) => order.agentSessionId === "agent-c")?.requiredContract
    ).toContain("Task keeps title:string");
  });

  it("keeps a decision-backed episode owner stable and records RocketRide run ids", () => {
    const agents = [
      makeAgent("agent-a", "wt-a", 1),
      makeAgent("agent-b", "wt-b", 2),
      makeAgent("agent-c", "wt-c", 3)
    ];

    const plan = buildCoordinationEpisodes({
      repoId: "repo-1",
      conflicts: [
        {
          ...makeConflict("conflict-ab", ["wt-a", "wt-b"]),
          classification: {
            kind: "blocking_conflict",
            rationale: "Pair AB prefers A.",
            recommendedOwnerWorktreeId: "wt-a",
            source: "openai",
            confidence: 0.95
          }
        },
        {
          ...makeConflict("conflict-bc", ["wt-b", "wt-c"]),
          classification: {
            kind: "blocking_conflict",
            rationale: "Pair BC prefers C.",
            recommendedOwnerWorktreeId: "wt-c",
            source: "openai",
            confidence: 0.95
          }
        }
      ],
      agents,
      decisions: [
        {
          id: "decision-1",
          repoId: "repo-1",
          conflictId: "conflict-ab",
          selectedOptionId: "split-ownership",
          selectedOptionTitle: "Split ownership",
          selectedOptionDirection: "Agent B owns Task contract.",
          ownerAgentSessionId: "agent-b",
          createdBy: "agent",
          status: "active",
          createdAt: now,
          updatedAt: now
        }
      ],
      publications: [],
      existingEpisodes: [
        {
          id: "existing-episode",
          repoId: "repo-1",
          surface: "Task contract",
          status: "coordinating",
          risk: "high",
          confidence: 0.9,
          affectedWorktreeIds: ["wt-a", "wt-b", "wt-c"],
          affectedAgentSessionIds: ["agent-a", "agent-b", "agent-c"],
          conflictIds: ["conflict-ab"],
          ownerAgentSessionId: "agent-b",
          rocketRideRunIds: ["rr-old"],
          createdAt: now - 100,
          updatedAt: now - 50
        }
      ],
      rocketRideRunIds: ["rr-new"],
      createdAt: now
    });

    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0]?.ownerAgentSessionId).toBe("agent-b");
    expect(plan.episodes[0]?.rocketRideRunIds).toEqual(["rr-old", "rr-new"]);
  });

  it("marks an episode coordinated once every current work order is completed", () => {
    const agents = [
      makeAgent("agent-a", "wt-a", 1),
      makeAgent("agent-b", "wt-b", 2)
    ];
    const conflict = makeConflict("conflict-ab", ["wt-a", "wt-b"]);
    const plan = buildCoordinationEpisodes({
      repoId: "repo-1",
      conflicts: [conflict],
      agents,
      decisions: [
        {
          id: "decision-1",
          repoId: "repo-1",
          conflictId: "conflict-ab",
          selectedOptionId: "split-ownership",
          selectedOptionTitle: "Split ownership",
          selectedOptionDirection: "Agent A owns Task contract.",
          ownerAgentSessionId: "agent-a",
          createdBy: "agent",
          status: "active",
          createdAt: now,
          updatedAt: now
        }
      ],
      publications: [
        {
          id: "publication-1",
          repoId: "repo-1",
          conflictId: "conflict-ab",
          ownerAgentSessionId: "agent-a",
          surface: "Task contract",
          shapeSummary:
            "Task includes title, label, project, subtitle, reminderAt, archived, and batchId.",
          files: ["src/shared/task.ts", "src/db/schema.ts"],
          createdAt: now
        }
      ],
      existingWorkOrders: [
        {
          id: "work-order-a",
          repoId: "repo-1",
          episodeId: stableEpisodeId("wt-a", "wt-b"),
          agentSessionId: "agent-a",
          role: "contract_owner",
          status: "completed",
          revision: 2,
          title: "Own Task contract",
          summary: "Agent A owns Task contract.",
          requiredContract: "Task includes title, label, project, subtitle, reminderAt, archived, and batchId.",
          allowedFiles: ["src/shared/task.ts"],
          blockedFiles: [],
          sharedFiles: ["src/shared/task.ts"],
          nextCheckpoint: "Done.",
          createdAt: now,
          updatedAt: now
        },
        {
          id: "work-order-b",
          repoId: "repo-1",
          episodeId: stableEpisodeId("wt-a", "wt-b"),
          agentSessionId: "agent-b",
          role: "adapter",
          status: "completed",
          revision: 2,
          title: "Adapt to Task contract",
          summary: "Agent B adapts to Task contract.",
          requiredContract: "Task includes title, label, project, subtitle, reminderAt, archived, and batchId.",
          allowedFiles: ["src/shared/task.ts"],
          blockedFiles: [],
          sharedFiles: ["src/shared/task.ts"],
          nextCheckpoint: "Done.",
          createdAt: now,
          updatedAt: now
        }
      ],
      createdAt: now
    });

    expect(plan.episodes[0]).toMatchObject({
      status: "coordinated",
      risk: "medium"
    });
  });
});

function makeAgent(
  id: string,
  worktreeId: string,
  joinedOffset: number
): AgentSession {
  return {
    id,
    repoId: "repo-1",
    worktreeId,
    agentKind: "codex",
    coordinationRole: "feature",
    cwd: `/repo/${worktreeId}`,
    displayName: id,
    lastCheckpointAt: now,
    joinedAt: now + joinedOffset
  };
}

function stableEpisodeId(...worktreeIds: string[]): string {
  return stableId(
    "coordination-episode",
    "repo-1",
    "Task contract",
    [...worktreeIds].sort().join("|")
  );
}

function makeConflict(id: string, worktreeIds: string[]): TempoConflict {
  return {
    id,
    repoId: "repo-1",
    status: "open",
    risk: "high",
    confidence: 0.86,
    type: "schema",
    title: "Task contract overlap",
    summary: "Multiple worktrees are changing Task contract.",
    primarySurface: "Task contract",
    affectedWorktreeIds: worktreeIds,
    affectedSurfaces: ["Task model", "Task type"],
    evidence: ["Both fingerprints touch Task contract."],
    riskReasons: [
      {
        label: "Shared contract root",
        detail: "Multiple worktrees touch Task contract surfaces.",
        weight: 90
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}
