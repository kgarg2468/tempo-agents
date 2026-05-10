import type { CloudEscalationPacket, Fingerprint, RebaseConflict } from "@rebase/shared";
import { stableId } from "./ids.js";
import { redactForCloud } from "./privacy.js";

export function createCloudEscalationCandidate(input: {
  repoRoot: string;
  conflict: RebaseConflict;
  fingerprints: Fingerprint[];
  evidencePacketIds?: string[] | undefined;
  provider?: string | undefined;
  createdAt: number;
}): CloudEscalationPacket {
  const affectedFingerprints = input.fingerprints.filter((fingerprint) =>
    input.conflict.affectedWorktreeIds.includes(fingerprint.worktreeId)
  );
  const redacted = redactForCloud(
    {
      conflict: {
        id: input.conflict.id,
        risk: input.conflict.risk,
        confidence: input.conflict.confidence,
        type: input.conflict.type,
        title: input.conflict.title,
        summary: input.conflict.summary,
        primarySurface: input.conflict.primarySurface,
        affectedWorktreeIds: input.conflict.affectedWorktreeIds,
        affectedSurfaces: input.conflict.affectedSurfaces,
        evidence: input.conflict.evidence,
        riskReasons: input.conflict.riskReasons,
        classification: input.conflict.classification,
        tokenCostEstimate: input.conflict.tokenCostEstimate,
        debate: input.conflict.debate
      },
      fingerprints: affectedFingerprints.map((fingerprint) => ({
        worktreeId: fingerprint.worktreeId,
        diffHash: fingerprint.diffHash,
        filesTouched: fingerprint.filesTouched,
        surfaces: fingerprint.surfaces,
        semanticSummary: fingerprint.semanticSummary,
        contractChanges: fingerprint.contractChanges,
        confidence: fingerprint.confidence,
        source: fingerprint.source
      }))
    },
    input.repoRoot
  );

  return {
    id: stableId("cloud-escalation", input.conflict.repoId, input.conflict.id),
    repoId: input.conflict.repoId,
    conflictId: input.conflict.id,
    evidencePacketIds: input.evidencePacketIds ?? [],
    provider: input.provider ?? "openai",
    reason: `${input.conflict.risk} Rebase collision candidate on ${input.conflict.primarySurface}`,
    status: "candidate",
    redactions: redacted.redactions,
    redactedContext: redacted.value as Record<string, unknown>,
    createdAt: input.createdAt
  };
}
