import type { AgentSession, RebaseConflict } from "@rebase/shared";
import { describe, expect, it } from "vitest";
import { buildCoordinationEpisodes } from "./episodes.js";

const now = 1778000000000;

describe("coordination episodes", () => {
  it("groups N pairwise conflicts on the same surface into one episode with one owner and many adapters", () => {
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
      ownerAgentSessionId: "agent-a"
    });
    expect(plan.workOrders).toHaveLength(3);
    expect(
      plan.workOrders.map((order) => ({
        agentSessionId: order.agentSessionId,
        role: order.role,
        status: order.status
      }))
    ).toEqual([
      { agentSessionId: "agent-a", role: "contract_owner", status: "queued" },
      { agentSessionId: "agent-b", role: "adapter", status: "queued" },
      { agentSessionId: "agent-c", role: "adapter", status: "queued" }
    ]);
    expect(plan.workOrders[1]?.summary).toContain("agent-a owns Task contract");
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

function makeConflict(id: string, worktreeIds: string[]): RebaseConflict {
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
