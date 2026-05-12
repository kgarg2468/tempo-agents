import type { Advisory, TempoConflict } from "@tempo/shared";
import { advisorySchema } from "@tempo/shared";
import { stableId } from "./ids.js";

export function createHeuristicAdvisory(
  conflict: TempoConflict,
  createdAt = Date.now()
): Advisory {
  const primarySurface = conflict.primarySurface;
  const supportingSurfaces = conflict.affectedSurfaces
    .filter((surface) => surface !== primarySurface)
    .slice(0, 4);
  const surfaceContext =
    supportingSurfaces.length > 0
      ? `${primarySurface} (${supportingSurfaces.join(", ")})`
      : primarySurface;
  const advisory: Advisory = {
    id: stableId("advisory", conflict.id, String(createdAt)),
    repoId: conflict.repoId,
    conflictId: conflict.id,
    source: "heuristic",
    createdAt,
    options: [
      {
        id: stableId(conflict.id, "contract-first"),
        title: "Agree contract first",
        direction: `Pause dependent edits and agree the ${primarySurface} shape before changing dependent routes, DTOs, or components.`,
        rationale: `The active conflict evidence points to ${surfaceContext}, so downstream code should wait for one contract shape.`,
        affectedSurfaces: conflict.affectedSurfaces
      },
      {
        id: stableId(conflict.id, "split-ownership"),
        title: "Split ownership",
        direction: `Assign one worktree to own ${primarySurface}; the other affected worktrees should adapt after the owner publishes the contract shape.`,
        rationale: "A single owner reduces parallel edits to the same contract surface.",
        affectedSurfaces: conflict.affectedSurfaces
      },
      {
        id: stableId(conflict.id, "compatibility-layer"),
        title: "Keep compatibility",
        direction: `Preserve backward-compatible behavior around ${primarySurface} until the affected worktrees converge on the same API/type shape.`,
        rationale: "Compatibility reduces breakage when both branches are close to commit.",
        affectedSurfaces: conflict.affectedSurfaces
      }
    ]
  };

  return advisorySchema.parse(advisory);
}
