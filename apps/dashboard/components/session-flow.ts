import type { Edge, Node } from "@xyflow/react";
import type { TempoGraphEdge, TempoGraphNode } from "@tempo/shared";

interface TempoGraph {
  nodes: TempoGraphNode[];
  edges: TempoGraphEdge[];
}

const KIND_COLUMNS: Partial<Record<TempoGraphNode["kind"], number>> = {
  repo: 70,
  worktree: 330,
  agent: 330,
  surface: 610,
  file: 610,
  conflict: 870,
  episode: 1030,
  decision: 1210,
  work_order: 1210,
  publication: 1210
};

const KIND_ORDER: Record<TempoGraphNode["kind"], number> = {
  repo: 0,
  worktree: 1,
  agent: 2,
  surface: 3,
  file: 4,
  conflict: 5,
  episode: 6,
  decision: 7,
  work_order: 8,
  publication: 9
};

export function flowFromTempoGraph(graph: TempoGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const columnCounts = new Map<number, number>();
  const flowNodes = [...graph.nodes].sort(compareGraphNodes).map((node) => {
    const x = KIND_COLUMNS[node.kind] ?? 70;
    const index = columnCounts.get(x) ?? 0;
    columnCounts.set(x, index + 1);
    return {
      id: node.id,
      position: {
        x,
        y: 90 + index * 120
      },
      data: {
        label: nodeLabel(node)
      },
      className: nodeClassName(node)
    };
  });

  const nodeIds = new Set(flowNodes.map((node) => node.id));
  const flowEdges = graph.edges
    .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
    .map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      animated:
        edge.kind === "touches" ||
        edge.kind === "affects" ||
        edge.metadata.status === "queued",
      className: edgeClassName(edge)
    }));

  return { nodes: flowNodes, edges: flowEdges };
}

function compareGraphNodes(left: TempoGraphNode, right: TempoGraphNode): number {
  return (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
}

function nodeLabel(node: TempoGraphNode): string {
  const status =
    typeof node.metadata.status === "string" ? ` (${node.metadata.status})` : "";
  return `${node.label}${status}`;
}

function nodeClassName(node: TempoGraphNode): string {
  const classes = ["tempo-node", `tempo-node-${node.kind}`];
  if (node.metadata.risk === "high" || node.metadata.status === "blocked") {
    classes.push("tempo-node-risk");
  }
  return classes.join(" ");
}

function edgeClassName(edge: TempoGraphEdge): string {
  if (edge.metadata.risk === "high") return "tempo-edge-risk";
  if (edge.kind === "touches" || edge.kind === "affects") {
    return "tempo-edge-active";
  }
  return "";
}
