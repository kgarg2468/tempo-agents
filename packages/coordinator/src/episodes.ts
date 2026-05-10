import type {
  AgentSession,
  ConflictDecision,
  ContractPublication,
  CoordinationEpisode,
  MergeContract,
  RebaseConflict,
  RiskLevel,
  WorkOrder
} from "@rebase/shared";
import { stableId } from "./ids.js";

export interface BuildCoordinationEpisodesInput {
  repoId: string;
  conflicts: RebaseConflict[];
  agents: AgentSession[];
  decisions: ConflictDecision[];
  publications: ContractPublication[];
  createdAt: number;
}

export interface BuildCoordinationEpisodesResult {
  episodes: CoordinationEpisode[];
  workOrders: WorkOrder[];
}

export function buildCoordinationEpisodes(
  input: BuildCoordinationEpisodesInput
): BuildCoordinationEpisodesResult {
  const openConflicts = input.conflicts.filter(
    (conflict) => conflict.status === "open"
  );
  const episodes: CoordinationEpisode[] = [];
  const workOrders: WorkOrder[] = [];

  for (const group of connectedConflictGroups(openConflicts)) {
    const affectedWorktreeIds = uniqueSorted(
      group.flatMap((conflict) => conflict.affectedWorktreeIds)
    );
    const affectedAgents = input.agents
      .filter(
        (agent) =>
          agent.worktreeId !== null && affectedWorktreeIds.includes(agent.worktreeId)
      )
      .sort(
        (a, b) =>
          a.joinedAt - b.joinedAt ||
          a.displayName.localeCompare(b.displayName) ||
          a.id.localeCompare(b.id)
      );
    if (affectedWorktreeIds.length < 2 || affectedAgents.length < 2) {
      continue;
    }
    const affectedAgentSessionIds = affectedAgents.map((agent) => agent.id);
    const conflictIds = uniqueSorted(group.map((conflict) => conflict.id));
    const surface = group[0]?.primarySurface ?? "shared surface";
    const episodeId = stableId(
      "coordination-episode",
      input.repoId,
      surface,
      affectedWorktreeIds.join("|")
    );
    const ownerAgentSessionId = selectOwnerAgentSessionId({
      conflicts: group,
      agents: affectedAgents,
      decisions: input.decisions
    });
    const mergeContract = buildMergeContract({
      repoId: input.repoId,
      episodeId,
      surface,
      conflictIds,
      ownerAgentSessionId,
      publications: input.publications,
      updatedAt: input.createdAt
    });
    const episode: CoordinationEpisode = {
      id: episodeId,
      repoId: input.repoId,
      surface,
      status: "coordinating",
      risk: highestRisk(group.map((conflict) => conflict.risk)),
      confidence: Math.max(...group.map((conflict) => conflict.confidence), 0),
      affectedWorktreeIds,
      affectedAgentSessionIds,
      conflictIds,
      ...(ownerAgentSessionId ? { ownerAgentSessionId } : {}),
      ...(mergeContract ? { mergeContract } : {}),
      rocketRideRunIds: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    };
    episodes.push(episode);

    for (const agent of affectedAgents) {
      workOrders.push(
        buildWorkOrder({
          repoId: input.repoId,
          episode,
          agent,
          owner: ownerAgentSessionId
            ? affectedAgents.find((candidate) => candidate.id === ownerAgentSessionId)
            : undefined,
          mergeContract,
          conflicts: group,
          createdAt: input.createdAt
        })
      );
    }
  }

  return { episodes, workOrders };
}

function connectedConflictGroups(conflicts: RebaseConflict[]): RebaseConflict[][] {
  const bySurface = new Map<string, RebaseConflict[]>();
  for (const conflict of conflicts) {
    const key = conflict.primarySurface || "shared surface";
    bySurface.set(key, [...(bySurface.get(key) ?? []), conflict]);
  }

  const groups: RebaseConflict[][] = [];
  for (const surfaceConflicts of bySurface.values()) {
    const remaining = new Set(surfaceConflicts.map((conflict) => conflict.id));
    const byId = new Map(surfaceConflicts.map((conflict) => [conflict.id, conflict]));

    while (remaining.size > 0) {
      const firstId = [...remaining].sort()[0];
      if (!firstId) break;
      const queue = [firstId];
      const componentIds = new Set<string>();
      const componentWorktrees = new Set<string>();

      while (queue.length > 0) {
        const id = queue.shift();
        if (!id || componentIds.has(id)) continue;
        const conflict = byId.get(id);
        if (!conflict) continue;
        componentIds.add(id);
        remaining.delete(id);
        for (const worktreeId of conflict.affectedWorktreeIds) {
          componentWorktrees.add(worktreeId);
        }

        for (const candidate of surfaceConflicts) {
          if (!remaining.has(candidate.id)) continue;
          if (
            candidate.affectedWorktreeIds.some((worktreeId) =>
              componentWorktrees.has(worktreeId)
            )
          ) {
            queue.push(candidate.id);
          }
        }
      }

      groups.push(
        [...componentIds]
          .map((id) => byId.get(id))
          .filter((conflict): conflict is RebaseConflict => Boolean(conflict))
          .sort((a, b) => a.id.localeCompare(b.id))
      );
    }
  }

  return groups.sort((a, b) =>
    (a[0]?.primarySurface ?? "").localeCompare(b[0]?.primarySurface ?? "")
  );
}

function selectOwnerAgentSessionId(input: {
  conflicts: RebaseConflict[];
  agents: AgentSession[];
  decisions: ConflictDecision[];
}): string | undefined {
  const conflictIds = new Set(input.conflicts.map((conflict) => conflict.id));
  const activeDecision = input.decisions
    .filter(
      (decision) =>
        decision.status === "active" &&
        decision.ownerAgentSessionId &&
        conflictIds.has(decision.conflictId)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (activeDecision?.ownerAgentSessionId) return activeDecision.ownerAgentSessionId;

  const recommendedOwnerWorktreeId = input.conflicts
    .map((conflict) => conflict.classification?.recommendedOwnerWorktreeId)
    .find(Boolean);
  if (recommendedOwnerWorktreeId) {
    const recommended = input.agents.find(
      (agent) => agent.worktreeId === recommendedOwnerWorktreeId
    );
    if (recommended) return recommended.id;
  }

  return input.agents[0]?.id;
}

function buildMergeContract(input: {
  repoId: string;
  episodeId: string;
  surface: string;
  conflictIds: string[];
  ownerAgentSessionId?: string | undefined;
  publications: ContractPublication[];
  updatedAt: number;
}): MergeContract | undefined {
  const conflictIds = new Set(input.conflictIds);
  const publication = input.publications
    .filter((candidate) => conflictIds.has(candidate.conflictId))
    .filter((candidate) =>
      input.ownerAgentSessionId
        ? candidate.ownerAgentSessionId === input.ownerAgentSessionId
        : true
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!publication) return undefined;

  return {
    id: stableId("merge-contract", input.episodeId, publication.id),
    repoId: input.repoId,
    episodeId: input.episodeId,
    surface: input.surface,
    ownerAgentSessionId: publication.ownerAgentSessionId,
    summary: publication.shapeSummary,
    files: publication.files,
    sourcePublicationId: publication.id,
    updatedAt: input.updatedAt
  };
}

function buildWorkOrder(input: {
  repoId: string;
  episode: CoordinationEpisode;
  agent: AgentSession;
  owner?: AgentSession | undefined;
  mergeContract?: MergeContract | undefined;
  conflicts: RebaseConflict[];
  createdAt: number;
}): WorkOrder {
  const role =
    input.episode.ownerAgentSessionId === input.agent.id
      ? "contract_owner"
      : "adapter";
  const revision = input.mergeContract?.sourcePublicationId ? 2 : 1;
  const ownerName = input.owner?.displayName ?? "the contract owner";
  const sharedFiles = uniqueSorted(
    input.conflicts.flatMap((conflict) =>
      conflict.evidence
        .filter((item) => item.includes("/"))
        .map((item) => item.replace(/^File overlap: /, ""))
    )
  );
  const contractSummary =
    input.mergeContract?.summary ??
    `${ownerName} owns ${input.episode.surface}; preserve that public shape before dependent edits.`;

  return {
    id: stableId("work-order", input.episode.id, input.agent.id, String(revision)),
    repoId: input.repoId,
    episodeId: input.episode.id,
    agentSessionId: input.agent.id,
    role,
    status: "queued",
    revision,
    title:
      role === "contract_owner"
        ? `Own ${input.episode.surface}`
        : `Adapt to ${input.episode.surface}`,
    summary:
      role === "contract_owner"
        ? `${input.agent.displayName} owns ${input.episode.surface}. Publish the canonical contract, then checkpoint before downstream edits.`
        : `${ownerName} owns ${input.episode.surface}. Adapt this worktree to the required contract, keep changes additive where possible, then checkpoint.`,
    requiredContract: contractSummary,
    allowedFiles: [],
    blockedFiles: [],
    sharedFiles,
    nextCheckpoint:
      role === "contract_owner"
        ? "Publish the contract shape with rebase_checkpoint before dependent edits."
        : "Checkpoint after adapting to the owner contract and before final response.",
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function highestRisk(risks: RiskLevel[]): RiskLevel {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}
