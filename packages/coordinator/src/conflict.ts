import type {
  CompatibilityClassification,
  ContractSurface,
  Fingerprint,
  RiskLevel,
  SurfaceKind,
  TempoConflict
} from "@tempo/shared";
import { createHash } from "node:crypto";

export interface DetectConflictOptions {
  classifications?: Map<string, CompatibilityClassification>;
}

export function detectConflicts(
  fingerprints: Fingerprint[],
  options: DetectConflictOptions = {}
): TempoConflict[] {
  const conflicts: TempoConflict[] = [];
  const sorted = [...fingerprints].sort((a, b) => a.id.localeCompare(b.id));

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i];
      const right = sorted[j];
      if (!left || !right || left.worktreeId === right.worktreeId) continue;

      const classification = options.classifications?.get(
        classificationKey(left.worktreeId, right.worktreeId)
      );
      const conflict = compareFingerprints(left, right, classification);
      if (conflict) conflicts.push(conflict);
    }
  }

  return conflicts;
}

function compareFingerprints(
  left: Fingerprint,
  right: Fingerprint,
  classification?: CompatibilityClassification
): TempoConflict | null {
  const sharedSurfaceLabels = intersection(
    left.surfaces.map((surface) => surface.label),
    right.surfaces.map((surface) => surface.label)
  );
  const sharedFiles = intersection(left.filesTouched, right.filesTouched);
  const sharedSymbols = intersection(
    [...left.symbols.added, ...left.symbols.modified],
    [...right.symbols.added, ...right.symbols.modified]
  );
  const sharedSurfaces = sharedSurfaceLabels.flatMap((label) =>
    matchingSurfaces(label, left.surfaces, right.surfaces)
  );

  if (
    sharedSurfaceLabels.length === 0 &&
    sharedFiles.length === 0 &&
    sharedSymbols.length === 0
  ) {
    return null;
  }
  if (classification?.kind === "no_issue") return null;

  const assessment = assessRisk(sharedSurfaces, sharedFiles, sharedSymbols);
  if (
    assessment.risk === "low" &&
    classification?.kind !== "coordination_notice" &&
    classification?.kind !== "blocking_conflict"
  ) {
    return null;
  }

  const kinds = new Set(
    [...left.surfaces, ...right.surfaces]
      .filter((surface) => sharedSurfaceLabels.includes(surface.label))
      .map((surface) => surface.kind)
  );
  const type = kinds.has("schema")
    ? "schema"
    : kinds.has("api")
      ? "api"
      : kinds.has("component")
        ? "component"
        : kinds.has("type") || kinds.has("dto")
          ? "type"
          : "unknown";
  const now = Math.max(left.createdAt, right.createdAt);
  const risk =
    classification?.kind === "coordination_notice"
      ? "low"
      : classification?.kind === "blocking_conflict"
        ? "high"
        : assessment.risk;
  const title =
    classification?.kind === "coordination_notice"
      ? `${assessment.primarySurface} coordination notice`
      : `${assessment.primarySurface} overlap`;
  const summary =
    classification?.kind === "coordination_notice"
      ? `Two worktrees are changing ${assessment.primarySurface}, but Tempo classified the overlap as compatible.`
      : `Two worktrees are changing ${assessment.primarySurface}.`;

  return {
    id: conflictId(left, right, assessment.primarySurface),
    repoId: left.repoId,
    status: "open",
    risk,
    confidence: clamp(
      Math.max(left.confidence, right.confidence) -
        (risk === "high" ? 0.03 : risk === "medium" ? 0.08 : 0.12)
    ),
    type,
    title,
    summary,
    primarySurface: assessment.primarySurface,
    affectedWorktreeIds: [left.worktreeId, right.worktreeId],
    affectedSurfaces:
      assessment.affectedSurfaces.length > 0
        ? assessment.affectedSurfaces
        : [assessment.primarySurface],
    evidence: [
      ...assessment.riskReasons.map(
        (reason) => `${reason.label}: ${reason.detail}`
      ),
      ...sharedSurfaceLabels.map((surface) => `Both fingerprints touch ${surface}`),
      ...sharedFiles.map((file) => `Both worktrees changed ${file}`),
      ...sharedSymbols.map((symbol) => `Both worktrees changed ${symbol}`),
      ...(classification ? [`Classifier: ${classification.rationale}`] : [])
    ],
    riskReasons: assessment.riskReasons,
    ...(classification ? { classification } : {}),
    createdAt: now,
    updatedAt: now
  };
}

interface RiskAssessment {
  risk: RiskLevel;
  primarySurface: string;
  affectedSurfaces: string[];
  riskReasons: TempoConflict["riskReasons"];
}

const CONTRACT_KINDS = new Set<SurfaceKind>([
  "schema",
  "model",
  "migration",
  "type",
  "dto",
  "api"
]);

const LOW_SIGNAL_KINDS = new Set<SurfaceKind>(["test", "utility", "unknown"]);

function assessRisk(
  sharedSurfaces: ContractSurface[],
  sharedFiles: string[],
  sharedSymbols: string[]
): RiskAssessment {
  const affectedSurfaces = [...new Set(sharedSurfaces.map((surface) => surface.label))]
    .sort((a, b) => surfaceRank(b, sharedSurfaces) - surfaceRank(a, sharedSurfaces));
  const contractRoots = contractRootCounts(sharedSurfaces);
  const topContractRoot = [...contractRoots.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0]?.[0];
  const primarySurface =
    topContractRoot !== undefined
      ? `${topContractRoot} contract`
      : affectedSurfaces[0] ?? sharedFiles[0] ?? sharedSymbols[0] ?? "shared surface";

  if (topContractRoot) {
    return {
      risk: "high",
      primarySurface,
      affectedSurfaces,
      riskReasons: [
        {
          label: "Shared contract root",
          detail: `Both worktrees touch ${topContractRoot} contract surfaces.`,
          weight: 90
        }
      ]
    };
  }

  const meaningfulSurface = sharedSurfaces.find(
    (surface) => !LOW_SIGNAL_KINDS.has(surface.kind)
  );
  if (meaningfulSurface) {
    return {
      risk: "medium",
      primarySurface,
      affectedSurfaces,
      riskReasons: [
        {
          label: "Shared surface",
          detail: `Both worktrees touch ${meaningfulSurface.label}.`,
          weight: 60
        }
      ]
    };
  }

  const riskyFile = sharedFiles.find(isRiskyFile);
  if (riskyFile) {
    return {
      risk: "medium",
      primarySurface,
      affectedSurfaces,
      riskReasons: [
        {
          label: "Shared contract file",
          detail: `Both worktrees changed ${riskyFile}.`,
          weight: 55
        }
      ]
    };
  }

  if (sharedSymbols.length > 0) {
    return {
      risk: "medium",
      primarySurface,
      affectedSurfaces,
      riskReasons: [
        {
          label: "Shared symbol",
          detail: `Both worktrees changed ${sharedSymbols[0]}.`,
          weight: 50
        }
      ]
    };
  }

  return {
    risk: "low",
    primarySurface,
    affectedSurfaces,
    riskReasons: []
  };
}

function matchingSurfaces(
  label: string,
  left: ContractSurface[],
  right: ContractSurface[]
): ContractSurface[] {
  return [
    ...left.filter((surface) => surface.label === label),
    ...right.filter((surface) => surface.label === label)
  ];
}

function contractRootCounts(surfaces: ContractSurface[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const surface of surfaces) {
    if (!CONTRACT_KINDS.has(surface.kind)) continue;
    const root = contractRoot(surface);
    if (!root) continue;
    counts.set(root, (counts.get(root) ?? 0) + surfaceWeight(surface));
  }
  return counts;
}

function contractRoot(surface: ContractSurface): string | null {
  if (isHttpMethodSurface(surface.label)) return null;
  const root = surface.label
    .replace(/\s+(model|type|DTO|API|contract)$/i, "")
    .trim();
  if (!root || /^(routecontext|schema|unknown)$/i.test(root)) return null;
  if (/^[A-Z]+$/.test(root)) return null;
  return root;
}

function surfaceRank(label: string, surfaces: ContractSurface[]): number {
  return Math.max(
    ...surfaces
      .filter((surface) => surface.label === label)
      .map((surface) => surfaceWeight(surface)),
    0
  );
}

function surfaceWeight(surface: ContractSurface): number {
  if (surface.kind === "schema" || surface.kind === "model") return 100;
  if (surface.kind === "migration") return 95;
  if (surface.kind === "type" || surface.kind === "dto") return 90;
  if (surface.kind === "api") return isHttpMethodSurface(surface.label) ? 45 : 80;
  if (surface.kind === "component") return 60;
  if (surface.kind === "utility") return 20;
  if (surface.kind === "test") return 10;
  return 25;
}

function isHttpMethodSurface(label: string): boolean {
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+API$/.test(label);
}

function isRiskyFile(filePath: string): boolean {
  return /(schema|model|entity|migration|route|routes|api|dto|types|interfaces|contract)/i.test(
    filePath
  );
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((item) => rightSet.has(item)).sort();
}

function conflictId(left: Fingerprint, right: Fingerprint, surface: string): string {
  return createHash("sha1")
    .update([left.repoId, left.worktreeId, right.worktreeId, surface].sort().join(":"))
    .digest("hex")
    .slice(0, 16);
}

export function classificationKey(leftWorktreeId: string, rightWorktreeId: string): string {
  return [leftWorktreeId, rightWorktreeId].sort().join(":");
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
