"use client";

import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { TempoGraphEdge, TempoGraphNode } from "@tempo/shared";
import { flowFromTempoGraph } from "./session-flow";

interface SessionMapProps {
  graph: {
    nodes: TempoGraphNode[];
    edges: TempoGraphEdge[];
  };
}

export function SessionMap({ graph }: SessionMapProps) {
  const { nodes, edges } = flowFromTempoGraph(graph);
  return (
    <div className="surface map-shell">
      <ReactFlow
        className="tempo-flow"
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
