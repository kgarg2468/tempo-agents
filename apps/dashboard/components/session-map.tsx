"use client";

import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node
} from "@xyflow/react";
import type {
  Fingerprint,
  RebaseConflict,
  RebaseRepo,
  RebaseWorktree
} from "@rebase/shared";
import {
  activeSessionConflict,
  surfaceId,
  surfaceLabelsForSessionGraph,
  targetSurfacesForFingerprint
} from "./session-graph";

interface SessionMapProps {
  repo: RebaseRepo | null;
  worktrees: RebaseWorktree[];
  fingerprints: Fingerprint[];
  conflicts: RebaseConflict[];
}

export function SessionMap({
  repo,
  worktrees,
  fingerprints,
  conflicts
}: SessionMapProps) {
  const { nodes, edges } = buildGraph({ repo, worktrees, fingerprints, conflicts });
  return (
    <div className="surface map-shell">
      <ReactFlow
        className="rebase-flow"
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(151, 164, 184, 0.16)" gap={26} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function buildGraph({
  repo,
  worktrees,
  fingerprints,
  conflicts
}: SessionMapProps): { nodes: Node[]; edges: Edge[] } {
  const rootId = "repo-root";
  const activeConflict = activeSessionConflict(conflicts);
  const riskyWorktrees = new Set(activeConflict?.affectedWorktreeIds ?? []);
  const riskySurfaces = new Set(activeConflict?.affectedSurfaces ?? []);
  const surfaceLabels = surfaceLabelsForSessionGraph({ fingerprints, conflicts });
  const visibleWorktrees = worktrees.length > 0 ? worktrees : [];

  const nodes: Node[] = [
    {
      id: rootId,
      type: "default",
      position: { x: 70, y: 260 },
      data: {
        label: (
          <NodeLabel
            title={repo?.name ?? "repo"}
            subtitle={repo?.rootPath ?? "waiting for coordinator"}
          />
        )
      },
      className: "rebase-node"
    },
    ...visibleWorktrees.map((worktree, index) => ({
      id: worktree.id,
      position: { x: 330, y: 120 + index * 160 },
      data: {
        label: (
          <NodeLabel
            title={worktree.branch ?? pathLeaf(worktree.path)}
            subtitle={worktree.dirty ? "dirty worktree" : "clean worktree"}
          />
        )
      },
      className: `rebase-node ${riskyWorktrees.has(worktree.id) ? "rebase-node-risk" : ""}`
    })),
    ...surfaceLabels.map((surface, index) => ({
      id: surfaceId(surface),
      position: { x: 670, y: 160 + index * 130 },
      data: {
        label: (
          <NodeLabel
            title={surface}
            subtitle={
              activeConflict && surface === activeConflict.primarySurface
                ? `${activeConflict.affectedSurfaces.length} surfaces grouped`
                : riskySurfaces.has(surface)
                  ? "converging surface"
                  : "surface"
            }
          />
        )
      },
      className: `rebase-node ${riskySurfaces.has(surface) ? "rebase-node-risk" : ""}`
    }))
  ];

  const edges: Edge[] = [
    ...visibleWorktrees.map((worktree) => ({
      id: `${rootId}-${worktree.id}`,
      source: rootId,
      target: worktree.id,
      animated: worktree.dirty
    })),
    ...dedupeEdges(
      fingerprints.flatMap((fingerprint) =>
        targetSurfacesForFingerprint(fingerprint, activeConflict).map((surface) => {
          const risky =
            riskyWorktrees.has(fingerprint.worktreeId) &&
            (activeConflict
              ? surface === activeConflict.primarySurface
              : riskySurfaces.has(surface));
        return {
          id: `${fingerprint.worktreeId}-${surfaceId(surface)}`,
          source: fingerprint.worktreeId,
          target: surfaceId(surface),
          animated: fingerprint.confidence > 0.5,
          className: risky ? "rebase-edge-risk" : "rebase-edge-active"
        };
        })
      )
    )
  ];

  return { nodes, edges };
}

function dedupeEdges(edges: Edge[]): Edge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}

function pathLeaf(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

function NodeLabel({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="rebase-node-label">
      <strong>{title}</strong>
      <span className="muted small rebase-node-subtitle">{subtitle}</span>
    </div>
  );
}
