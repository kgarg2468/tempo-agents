import type { AgentSession, EvidencePacket, Fingerprint } from "@tempo/shared";
import {
  extractChangedFilesFromDiff,
  getWorktreeDiff,
  hashNormalizedDiff,
  normalizeDiff
} from "./git.js";
import { stableId } from "./ids.js";
import { createTempoPathFilter } from "./path-ignore.js";
import type { TempoStore } from "./store.js";

export const LOCAL_EVIDENCE_RETENTION_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AssembleEvidencePacketInput {
  repoId: string;
  repoRoot: string;
  store: TempoStore;
  session: AgentSession;
  now: number;
}

export async function assembleEvidencePacket(
  input: AssembleEvidencePacketInput
): Promise<EvidencePacket> {
  const packetId = stableId("evidence", input.repoId, input.session.id);
  const existing = input.store
    .listEvidencePackets(input.repoId)
    .find((packet) => packet.id === packetId);
  const git = await collectGitEvidence(input);
  const hookEvents = input.store.listHookEvents(input.repoId, input.session.id);
  const latestPrompt = [...hookEvents]
    .reverse()
    .find((event) => event.prompt && event.prompt.trim().length > 0)?.prompt;
  const source = input.session.currentPlan || git.surfaces.length > 0 ? "mixed" : "hooks";

  return {
    id: packetId,
    repoId: input.repoId,
    sessionId: input.session.id,
    worktreeId: input.session.worktreeId,
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
    expiresAt: input.now + LOCAL_EVIDENCE_RETENTION_DAYS * DAY_MS,
    source,
    ...(latestPrompt ? { promptSummary: truncate(latestPrompt, 500) } : {}),
    ...(input.session.currentPlan
      ? { planSummary: truncate(input.session.currentPlan, 500) }
      : {}),
    hookEvents,
    git: git.state,
    surfaces: git.surfaces,
    decisionHistory: input.store.listConflictDecisions(input.repoId).map((decision) => ({
      id: decision.id,
      conflictId: decision.conflictId,
      summary: `${decision.selectedOptionTitle}: ${decision.selectedOptionDirection}`,
      createdAt: decision.createdAt
    })),
    privacy: {
      retentionDays: LOCAL_EVIDENCE_RETENTION_DAYS,
      redactions: [],
      cloudEligible: false
    }
  };
}

async function collectGitEvidence(input: AssembleEvidencePacketInput): Promise<{
  state: EvidencePacket["git"];
  surfaces: EvidencePacket["surfaces"];
}> {
  const worktree = input.store
    .listWorktrees(input.repoId)
    .find((candidate) => candidate.id === input.session.worktreeId);
  const filteredDiff = await safeFilteredDiff(input.repoRoot, input.session.cwd);
  const normalized = normalizeDiff(filteredDiff);
  const filesTouched = normalized ? extractChangedFilesFromDiff(filteredDiff) : [];
  const latestFingerprint = latestFingerprintForWorktree(
    input.store.listFingerprints(input.repoId),
    input.session.worktreeId
  );

  return {
    state: {
      branch: worktree?.branch ?? null,
      headSha: worktree?.headSha ?? null,
      mergeBase: null,
      diffHash: normalized ? hashNormalizedDiff(normalized) : null,
      filesTouched,
      stats: diffStats(filteredDiff, filesTouched.length)
    },
    surfaces: latestFingerprint?.surfaces ?? []
  };
}

async function safeFilteredDiff(repoRoot: string, cwd: string): Promise<string> {
  try {
    const filter = createTempoPathFilter(repoRoot);
    return filter.filterDiff(await getWorktreeDiff(cwd));
  } catch (_error) {
    return "";
  }
}

function latestFingerprintForWorktree(
  fingerprints: Fingerprint[],
  worktreeId: string | null
): Fingerprint | null {
  if (!worktreeId) return null;
  return (
    fingerprints
      .filter((fingerprint) => fingerprint.worktreeId === worktreeId)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

function diffStats(
  diff: string,
  filesChanged: number
): EvidencePacket["git"]["stats"] {
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return {
    filesChanged,
    insertions,
    deletions
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
