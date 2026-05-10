import type {
  DebateVerdict,
  Fingerprint,
  RebaseConflict,
  TokenCostEstimate
} from "@rebase/shared";

export function estimateTokenCost(
  conflict: RebaseConflict,
  fingerprints: Fingerprint[]
): TokenCostEstimate {
  const affectedFingerprints = fingerprints.filter((fingerprint) =>
    conflict.affectedWorktreeIds.includes(fingerprint.worktreeId)
  );
  const filesTouched = new Set(
    affectedFingerprints.flatMap((fingerprint) => fingerprint.filesTouched)
  ).size;
  const touchedSurfaces = new Set(conflict.affectedSurfaces).size;
  const riskMultiplier = conflict.risk === "high" ? 2 : conflict.risk === "medium" ? 1.35 : 0.8;
  const reworkMultiplier =
    conflict.type === "schema" || conflict.type === "api"
      ? 2.5
      : conflict.type === "component" || conflict.type === "type"
        ? 1.8
        : 1.2;
  const estimatedTokens = Math.round(
    500 +
      filesTouched * 120 +
      touchedSurfaces * 180 +
      conflict.confidence * 200 +
      riskMultiplier * reworkMultiplier * 250
  );

  return {
    estimatedTokens,
    formula:
      "base + filesTouched*120 + touchedSurfaces*180 + confidence*200 + riskMultiplier*reworkMultiplier*250",
    inputs: {
      filesTouched,
      touchedSurfaces,
      confidence: conflict.confidence,
      riskMultiplier,
      reworkMultiplier
    }
  };
}

export function createLocalDebateVerdict(
  conflict: RebaseConflict,
  fingerprints: Fingerprint[]
): DebateVerdict {
  const affectedSummaries = fingerprints
    .filter((fingerprint) =>
      conflict.affectedWorktreeIds.includes(fingerprint.worktreeId)
    )
    .map((fingerprint) => `${fingerprint.worktreeId}: ${fingerprint.semanticSummary}`)
    .slice(0, 4);
  const verdict = verdictFor(conflict);
  const classifierRationale = conflict.classification?.rationale;

  return {
    verdict,
    confidence: conflict.classification?.confidence ?? conflict.confidence,
    proposer: `${conflict.primarySurface} is shared by ${conflict.affectedWorktreeIds.length} active worktrees; unchecked overlap can create rework around ${conflict.affectedSurfaces.slice(0, 3).join(", ")}.`,
    skeptic:
      conflict.classification?.kind === "coordination_notice"
        ? `Compatibility evidence says this may proceed with coordination: ${classifierRationale}`
        : "The overlap might still be compatible if one agent owns the contract shape and the other adapts after a checkpoint.",
    judge: judgeLine(conflict, verdict),
    evidence: [...conflict.evidence, ...affectedSummaries].slice(0, 8),
    directions: directionsFor(conflict, verdict)
  };
}

export function withDebate(
  conflict: RebaseConflict,
  fingerprints: Fingerprint[]
): RebaseConflict {
  if (conflict.risk === "low") return conflict;
  return {
    ...conflict,
    tokenCostEstimate: estimateTokenCost(conflict, fingerprints),
    debate: createLocalDebateVerdict(conflict, fingerprints)
  };
}

function verdictFor(conflict: RebaseConflict): DebateVerdict["verdict"] {
  if (conflict.classification?.kind === "no_issue") return "compatible";
  if (conflict.classification?.kind === "coordination_notice") return "notice";
  return conflict.risk === "high" ? "blocking" : "notice";
}

function judgeLine(
  conflict: RebaseConflict,
  verdict: DebateVerdict["verdict"]
): string {
  if (verdict === "compatible") {
    return "Continue; no Rebase pause is needed for this overlap.";
  }
  if (verdict === "notice") {
    return "Continue with a checkpoint before commit and keep contract changes explicit.";
  }
  return `Blocking risk: pause at checkpoint/pre-commit until one owner publishes the ${conflict.primarySurface} shape and peers adapt.`;
}

function directionsFor(
  conflict: RebaseConflict,
  verdict: DebateVerdict["verdict"]
): string[] {
  if (verdict === "compatible") {
    return ["Continue; mention the compatibility evidence at the next checkpoint."];
  }
  if (verdict === "notice") {
    return [
      `Checkpoint before commit with the final ${conflict.primarySurface} shape.`,
      "Tell peer agents which fields/routes/props are additive."
    ];
  }
  return [
    `Choose an owner for ${conflict.primarySurface}.`,
    "Owner publishes the contract shape through checkpoint.",
    "Adapters wait for the owner shape, then update dependent code."
  ];
}
