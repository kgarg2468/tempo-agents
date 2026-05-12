import { describe, expect, it } from "vitest";
import type { TempoGraphEdge, TempoGraphNode } from "@tempo/shared";
import { flowFromTempoGraph } from "./session-flow";

describe("SessionMap graph", () => {
  it("renders canonical Tempo graph nodes for conflicts, episodes, work orders, and publications", () => {
    const nodes: TempoGraphNode[] = [
      graphNode("repo:repo-1", "repo", "todo-demo"),
      graphNode("worktree:wt-labels", "worktree", "codex-labels", {
        dirty: true
      }),
      graphNode("worktree:wt-notes", "worktree", "codex-notes", {
        dirty: true
      }),
      graphNode("agent:agent-labels", "agent", "Agent A"),
      graphNode("conflict:conflict-1", "conflict", "Task contract overlap", {
        risk: "high"
      }),
      graphNode("episode:episode-1", "episode", "Task contract", {
        status: "coordinating"
      }),
      graphNode("work_order:order-1", "work_order", "Adapt to Task contract", {
        role: "adapter",
        status: "queued"
      }),
      graphNode("publication:pub-1", "publication", "Published Task contract", {
        surface: "Task contract"
      })
    ];
    const edges: TempoGraphEdge[] = [
      graphEdge("repo:repo-1", "worktree:wt-labels", "contains"),
      graphEdge("repo:repo-1", "worktree:wt-notes", "contains"),
      graphEdge("conflict:conflict-1", "worktree:wt-labels", "affects"),
      graphEdge("conflict:conflict-1", "worktree:wt-notes", "affects"),
      graphEdge("episode:episode-1", "conflict:conflict-1", "relates_to"),
      graphEdge("work_order:order-1", "episode:episode-1", "relates_to"),
      graphEdge("publication:pub-1", "episode:episode-1", "relates_to")
    ];

    const flow = flowFromTempoGraph({ nodes, edges });

    expect(flow.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "conflict:conflict-1",
        "episode:episode-1",
        "work_order:order-1",
        "publication:pub-1"
      ])
    );
    expect(
      flow.nodes.find((node) => node.id === "conflict:conflict-1")?.className
    ).toContain("tempo-node-risk");
    expect(flow.edges.map((edge) => edge.id)).toContain(
      "publication:pub-1->episode:episode-1"
    );
    expect(flow.nodes.find((node) => node.id === "worktree:wt-labels")?.position.y)
      .not.toBe(flow.nodes.find((node) => node.id === "agent:agent-labels")?.position.y);
  });
});

function graphNode(
  id: string,
  kind: TempoGraphNode["kind"],
  label: string,
  metadata: TempoGraphNode["metadata"] = {}
): TempoGraphNode {
  return {
    id,
    repoId: "repo-1",
    kind,
    label,
    refId: id,
    metadata,
    updatedAt: 1778000000000
  };
}

function graphEdge(
  sourceId: string,
  targetId: string,
  kind: TempoGraphEdge["kind"]
): TempoGraphEdge {
  return {
    id: `${sourceId}->${targetId}`,
    repoId: "repo-1",
    sourceId,
    targetId,
    kind,
    metadata: {},
    updatedAt: 1778000000000
  };
}
