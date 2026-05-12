import type {
  AgentSession,
  CoordinationEpisode,
  CoordinationRole,
  ConflictDecision,
  ContractPublication,
  Fingerprint,
  Intervention,
  MergeRiskAssessment,
  RiskLevel,
  RebaseConflict,
  WorkOrder
} from "@rebase/shared";
import { execFileSync } from "node:child_process";
import { nanoid } from "nanoid";
import { createHeuristicAdvisory } from "./advisory.js";
import { buildCoordinationEpisodes } from "./episodes.js";
import {
  buildAgentSpecificDirective,
  directionFromDirective
} from "./guidance.js";
import { upsertAgentGraph } from "./graph.js";
import { worktreeIdFor } from "./ids.js";
import { isRocketRideRequired, type RocketRideCoordinator } from "./rocketride.js";
import type { RebaseStore } from "./store.js";

export interface McpToolContext {
  repoId: string;
  repoRoot: string;
  store: RebaseStore;
  rocketRide?: RocketRideCoordinator | undefined;
}

export interface JoinInput {
  cwd: string;
  agentKind?: "codex" | "claude" | "unknown";
  displayName?: string;
  coordinationRole?: CoordinationRole;
}

export interface JoinResult {
  sessionId: string;
  worktreeId: string;
  message: string;
}

export interface PlanInput {
  sessionId: string;
  plan: string;
}

export interface CheckpointInput {
  sessionId: string;
  publishContract?: PublishContractInput | undefined;
}

export interface PublishContractInput {
  conflictId?: string | undefined;
  surface: string;
  shapeSummary: string;
  files?: string[] | undefined;
}

export interface ConflictChoiceBrief {
  conflictId: string;
  title: string;
  summary: string;
  risk: RiskLevel;
  options: Array<{
    id: string;
    title: string;
    direction: string;
    rationale: string;
  }>;
}

export interface ActiveDecisionBrief {
  conflictId: string;
  selectedOptionTitle: string;
  selectedOptionDirection: string;
  ownerAgentSessionId?: string | undefined;
  createdBy: ConflictDecision["createdBy"];
}

export interface CheckpointResult {
  risk: RiskLevel;
  notifications: string[];
  notices: RebaseConflict[];
  choices: ConflictChoiceBrief[];
  directions: Intervention[];
  workOrders: WorkOrder[];
  coordinationEpisodes: CoordinationEpisode[];
  mergeRisks: MergeRiskAssessment[];
  activeDecisions: ActiveDecisionBrief[];
  publications: ContractPublication[];
  keepWaiting: boolean;
  pause: boolean;
}

export interface FetchInterventionInput {
  sessionId: string;
}

export interface SessionStateInput {
  sessionId: string;
}

export interface SessionStateResult {
  session: AgentSession | null;
  evidencePacketId?: string | undefined;
  activeRisks: RebaseConflict[];
  queuedDirections: Intervention[];
  queuedWorkOrders: WorkOrder[];
  coordinationEpisodes: CoordinationEpisode[];
  mergeRisks: MergeRiskAssessment[];
}

export interface CollisionRiskInput {
  sessionId?: string | undefined;
}

export interface CollisionRiskResult {
  risk: RiskLevel;
  conflicts: RebaseConflict[];
  cloudEscalationPacketIds: string[];
}

export interface FetchInterventionResult {
  directions: Intervention[];
  workOrders: WorkOrder[];
}

export interface RecordDecisionInput {
  sessionId?: string | undefined;
  conflictId: string;
  selectedOptionId: string;
  selectedOptionTitle: string;
  selectedOptionDirection: string;
  ownerAgentSessionId?: string | undefined;
  createdBy: "dashboard" | "agent";
}

export interface RecordDecisionResult {
  decision: ConflictDecision;
  interventions: Intervention[];
  alreadyDecided: boolean;
}

export interface WaitForDirectionInput {
  sessionId: string;
  timeoutMs?: number | undefined;
}

export interface WaitForDirectionResult {
  directions: Intervention[];
  workOrders: WorkOrder[];
  coordinationEpisodes: CoordinationEpisode[];
  mergeRisks: MergeRiskAssessment[];
  choices: ConflictChoiceBrief[];
  activeDecisions: ActiveDecisionBrief[];
  waitingOn?: WaitingOnBrief | undefined;
  keepWaiting: boolean;
  timedOut: boolean;
}

export interface WaitingOnBrief {
  type: "owner_contract_publication";
  conflictId: string;
  ownerAgentSessionId: string;
}

export interface AcknowledgeInterventionInput {
  sessionId: string;
  interventionId: string;
}

const MAX_WAIT_HEARTBEAT_MS = 110_000;
const WAIT_POLL_MS = 50;

export function createMcpToolHandlers(context: McpToolContext) {
  return {
    join(input: JoinInput): JoinResult {
      const now = Date.now();
      const worktreeId = worktreeIdFor(input.cwd);
      const session: AgentSession = {
        id: nanoid(16),
        repoId: context.repoId,
        worktreeId,
        agentKind: input.agentKind ?? "codex",
        coordinationRole: input.coordinationRole ?? "feature",
        cwd: input.cwd,
        displayName: input.displayName ?? "Codex",
        lastCheckpointAt: now,
        joinedAt: now
      };
      context.store.upsertAgentSession(session);
      upsertAgentGraph(context.store, session, now);
      context.store.addEvent({
        id: nanoid(16),
        repoId: context.repoId,
        type: "agent.joined",
        message: `${session.displayName} joined Rebase`,
        payload: { cwd: input.cwd, worktreeId },
        createdAt: now
      });
      return {
        sessionId: session.id,
        worktreeId,
        message: `Rebase is tracking this worktree as ${session.displayName}.`
      };
    },

    plan(input: PlanInput) {
      context.store.updateAgentPlan(input.sessionId, input.plan, Date.now());
      return {
        ok: true,
        message: "Rebase recorded this plan. Checkpoint after meaningful edit batches."
      };
    },

    checkpoint(input: CheckpointInput): CheckpointResult {
      const checkpointAt = Date.now();
      const session = context.store
        .listAgentSessions(context.repoId)
        .find((candidate) => candidate.id === input.sessionId);
      if (!session) {
        return {
          risk: "low",
          notifications: ["Rebase does not recognize this session. Call rebase_join."],
          notices: [],
          choices: [],
          directions: [],
          workOrders: [],
          coordinationEpisodes: [],
          mergeRisks: [],
          activeDecisions: [],
          publications: [],
          keepWaiting: false,
          pause: false
        };
      }
      context.store.updateAgentCheckpoint(input.sessionId, checkpointAt);

      if (input.publishContract && !input.publishContract.conflictId) {
        syncCoordinationState(context.store, context.repoId, checkpointAt, context.rocketRide);
      }
      const publication = input.publishContract
        ? publishContractShape({
            store: context.store,
            repoId: context.repoId,
            session,
            input: input.publishContract,
            createdAt: checkpointAt
          })
        : null;

      syncCoordinationState(context.store, context.repoId, checkpointAt, context.rocketRide);
      ensureQueuedDirectionsForSession(context.store, context.repoId, input.sessionId);
      const directions = deliverQueuedDirections(
        context.store,
        context.repoId,
        input.sessionId
      );
      const workOrders = deliverQueuedWorkOrders(
        context.store,
        context.repoId,
        input.sessionId,
        { includeActive: true }
      );
      const coordinationEpisodes = relevantCoordinationEpisodesForSession(
        context.store,
        context.repoId,
        input.sessionId
      );
      const mergeRisks = mergeRisksForEpisodes(
        context.store,
        context.repoId,
        coordinationEpisodes
      );
      const blockingMergeRisks = mergeRisks.filter(isBlockingMergeRisk);
      const affectingConflicts = conflictsForSession(
        context.store,
        context.repoId,
        session
      );
      const notices = affectingConflicts.filter(
        (conflict) =>
          conflict.classification?.kind === "coordination_notice" ||
          isIntegrationConflict(context.store, context.repoId, conflict)
      );
      const blockingConflicts = affectingConflicts.filter(
        (conflict) =>
          conflict.classification?.kind !== "coordination_notice" &&
          !isIntegrationConflict(context.store, context.repoId, conflict)
      );
      const episodeManagedConflictIds = new Set(
        coordinationEpisodes
          .filter((episode) => episode.ownerAgentSessionId)
          .flatMap((episode) => episode.conflictIds)
      );
      const unresolvedConflicts = blockingConflicts.filter(
        (conflict) =>
          !activeDecisionForConflictOrEpisode(
            context.store,
            context.repoId,
            conflict
          ) &&
          !episodeManagedConflictIds.has(conflict.id)
      );
      const activeDecisions = activeDecisionBriefsForConflicts(
        context.store,
        blockingConflicts
      );
      const workOrderEvaluations = evaluateWorkOrdersForCheckpoint({
        store: context.store,
        repoId: context.repoId,
        session,
        workOrders,
        coordinationEpisodes,
        evaluatedAt: checkpointAt
      });
      const workOrderViolations = workOrderEvaluations.filter(
        (evaluation) => !evaluation.satisfied
      );
      const conflictRisk = highestRisk(
        unresolvedConflicts.map((conflict) => conflict.risk)
      );
      const risk: RiskLevel =
        workOrderViolations.length > 0 || blockingMergeRisks.length > 0
          ? "high"
          : conflictRisk;
      const notifications = unresolvedConflicts.map(
        (conflict) =>
          `${conflict.risk.toUpperCase()} risk: ${conflict.title}. ${conflict.summary}`
      );
      for (const violation of workOrderViolations) {
        notifications.push(
          `HIGH risk: Active work order ${violation.workOrder.title} is incomplete; missing ${violation.missingTerms.join(", ")}.`
        );
      }
      for (const mergeRisk of blockingMergeRisks) {
        notifications.push(
          `HIGH risk: Predictive merge risk blocked ${mergeRisk.episodeId}; ${mergeRisk.predictedConflicts
            .map((conflict) => conflict.summary)
            .join(" ")}`
        );
      }
      for (const notice of notices) {
        notifications.push(
          `${
            isIntegrationConflict(context.store, context.repoId, notice)
              ? "Integration notice"
              : "NOTICE"
          }: ${notice.title}. ${notice.summary}`
        );
      }
      if (directions.length > 0) {
        notifications.push(
          `Rebase delivered ${directions.length} queued direction${
            directions.length === 1 ? "" : "s"
          } for this session.`
        );
      }
      if (workOrders.length > 0) {
        notifications.push(
          `Rebase delivered ${workOrders.length} work order${
            workOrders.length === 1 ? "" : "s"
          } for this session.`
        );
      }
      for (const decision of activeDecisions) {
        notifications.push(
          `Rebase decision active: ${decision.selectedOptionTitle} for conflict ${decision.conflictId}.`
        );
      }

      return {
        risk,
        notifications,
        notices,
        choices: choicesForConflicts(unresolvedConflicts),
        directions,
        workOrders,
        coordinationEpisodes,
        mergeRisks,
        activeDecisions,
        publications: [
          ...(publication ? [publication] : []),
          ...relevantPublicationsForSession(
            context.store,
            context.repoId,
            input.sessionId
          )
            .filter((item) => item.id !== publication?.id)
        ],
        keepWaiting:
          unresolvedConflicts.some(isBlockingConflict) ||
          workOrderViolations.length > 0 ||
          blockingMergeRisks.length > 0,
        pause:
          unresolvedConflicts.some(isBlockingConflict) ||
          workOrderViolations.length > 0 ||
          blockingMergeRisks.length > 0
      };
    },

    sessionState(input: SessionStateInput): SessionStateResult {
      const session =
        context.store
          .listAgentSessions(context.repoId)
          .find((candidate) => candidate.id === input.sessionId) ?? null;
      const evidencePacket = context.store
        .listEvidencePackets(context.repoId)
        .find((packet) => packet.sessionId === input.sessionId);
      return {
        session,
        ...(evidencePacket ? { evidencePacketId: evidencePacket.id } : {}),
        activeRisks: session
          ? conflictsForSession(context.store, context.repoId, session)
          : [],
        queuedDirections: context.store.listQueuedInterventions(
          context.repoId,
          input.sessionId
        ),
        queuedWorkOrders: context.store.listQueuedWorkOrders(
          context.repoId,
          input.sessionId
        ),
        coordinationEpisodes: session
          ? relevantCoordinationEpisodesForSession(
              context.store,
              context.repoId,
              input.sessionId
            )
          : [],
        mergeRisks: session
          ? mergeRisksForEpisodes(
              context.store,
              context.repoId,
              relevantCoordinationEpisodesForSession(
                context.store,
                context.repoId,
                input.sessionId
              )
            )
          : []
      };
    },

    collisionRisk(input: CollisionRiskInput = {}): CollisionRiskResult {
      const session = input.sessionId
        ? context.store
            .listAgentSessions(context.repoId)
            .find((candidate) => candidate.id === input.sessionId)
        : undefined;
      const conflicts = session
        ? conflictsForSession(context.store, context.repoId, session)
        : context.store
            .listConflicts(context.repoId)
            .filter((conflict) => conflict.status === "open");
      return {
        risk: highestRisk(conflicts.map((conflict) => conflict.risk)),
        conflicts,
        cloudEscalationPacketIds: context.store
          .listCloudEscalationPackets(context.repoId)
          .filter((packet) =>
            packet.conflictId
              ? conflicts.some((conflict) => conflict.id === packet.conflictId)
              : false
          )
          .map((packet) => packet.id)
      };
    },

    fetchIntervention(input: FetchInterventionInput): FetchInterventionResult {
      syncCoordinationState(context.store, context.repoId, Date.now(), context.rocketRide);
      ensureQueuedDirectionsForSession(context.store, context.repoId, input.sessionId);
      return {
        directions: deliverQueuedDirections(
          context.store,
          context.repoId,
          input.sessionId
        ),
        workOrders: deliverQueuedWorkOrders(
          context.store,
          context.repoId,
          input.sessionId,
          { includeActive: true }
        )
      };
    },

    recordDecision(input: RecordDecisionInput): RecordDecisionResult {
      const conflict = context.store
        .listConflicts(context.repoId)
        .find((candidate) => candidate.id === input.conflictId);
      if (!conflict) {
        throw new Error(`Conflict ${input.conflictId} not found`);
      }
      const episode = coordinationEpisodeForConflict(
        context.store,
        context.repoId,
        input.conflictId
      );
      const existing = activeDecisionForConflictOrEpisode(
        context.store,
        context.repoId,
        conflict
      );
      if (existing) {
        return {
          decision: existing,
          interventions: [],
          alreadyDecided: true
        };
      }

      const now = Date.now();
      const ownerAgentSessionId =
        input.ownerAgentSessionId ??
        (isSplitOwnershipDecision(input) ? input.sessionId : undefined);
      const decision: ConflictDecision = {
        id: nanoid(16),
        repoId: context.repoId,
        conflictId: conflict.id,
        selectedOptionId: input.selectedOptionId,
        selectedOptionTitle: input.selectedOptionTitle,
        selectedOptionDirection: input.selectedOptionDirection,
        ...(ownerAgentSessionId
          ? { ownerAgentSessionId }
          : {}),
        createdBy: input.createdBy,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      context.store.upsertConflictDecision(decision);
      const interventions = queueDecisionInterventions({
        store: context.store,
        repoId: context.repoId,
        conflict,
        episode,
        decision,
        createdAt: now
      });
      return {
        decision,
        interventions,
        alreadyDecided: false
      };
    },

    async waitForDirection(
      input: WaitForDirectionInput
    ): Promise<WaitForDirectionResult> {
      const timeoutMs = Math.min(
        Math.max(input.timeoutMs ?? MAX_WAIT_HEARTBEAT_MS, 0),
        MAX_WAIT_HEARTBEAT_MS
      );
      const start = Date.now();
      for (;;) {
        syncCoordinationState(context.store, context.repoId, Date.now(), context.rocketRide);
        ensureQueuedDirectionsForSession(context.store, context.repoId, input.sessionId);
        const directions = deliverQueuedDirections(
          context.store,
          context.repoId,
          input.sessionId
        );
        const workOrders = deliverQueuedWorkOrders(
          context.store,
          context.repoId,
          input.sessionId,
          { includeActive: false }
        );
        if (directions.length > 0 || workOrders.length > 0) {
          return {
            directions,
            workOrders,
            coordinationEpisodes: relevantCoordinationEpisodesForSession(
              context.store,
              context.repoId,
              input.sessionId
            ),
            mergeRisks: mergeRisksForEpisodes(
              context.store,
              context.repoId,
              relevantCoordinationEpisodesForSession(
                context.store,
                context.repoId,
                input.sessionId
              )
            ),
            choices: choicesForSession(context.store, context.repoId, input.sessionId),
            activeDecisions: activeDecisionBriefsForSession(
              context.store,
              context.repoId,
              input.sessionId
            ),
            waitingOn: undefined,
            keepWaiting: false,
            timedOut: false
          };
        }
        const elapsed = Date.now() - start;
        if (elapsed >= timeoutMs) break;
        await sleep(Math.min(WAIT_POLL_MS, timeoutMs - elapsed));
      }
      const choices = choicesForSession(context.store, context.repoId, input.sessionId);
      const waitingOn = waitingForOwnerPublication(
        context.store,
        context.repoId,
        input.sessionId
      );
      return {
        directions: [],
        workOrders: [],
        coordinationEpisodes: relevantCoordinationEpisodesForSession(
          context.store,
          context.repoId,
          input.sessionId
        ),
        mergeRisks: mergeRisksForEpisodes(
          context.store,
          context.repoId,
          relevantCoordinationEpisodesForSession(
            context.store,
            context.repoId,
            input.sessionId
          )
        ),
        choices,
        activeDecisions: activeDecisionBriefsForSession(
          context.store,
          context.repoId,
          input.sessionId
        ),
        ...(waitingOn ? { waitingOn } : {}),
        keepWaiting: choices.length > 0 || Boolean(waitingOn),
        timedOut: true
      };
    },

    acknowledgeIntervention(input: AcknowledgeInterventionInput) {
      const intervention = context.store
        .listInterventions(context.repoId)
        .find((candidate) => candidate.id === input.interventionId);
      if (
        !intervention ||
        !intervention.targetAgentSessionIds.includes(input.sessionId)
      ) {
        return { ok: false, message: "Intervention not found for this session." };
      }
      context.store.markInterventionAcknowledged(input.interventionId, Date.now());
      return { ok: true, message: "Rebase marked the direction as acknowledged." };
    }
  };
}

function deliverQueuedDirections(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): Intervention[] {
  const interventions = store.listQueuedInterventions(repoId, sessionId);
  const fetchedAt = Date.now();
  for (const intervention of interventions) {
    store.markInterventionFetched(intervention.id, fetchedAt);
  }
  return interventions;
}

function deliverQueuedWorkOrders(
  store: RebaseStore,
  repoId: string,
  sessionId: string,
  options: { includeActive?: boolean } = {}
): WorkOrder[] {
  const workOrders = store.listQueuedWorkOrders(repoId, sessionId);
  const fetchedAt = Date.now();
  for (const workOrder of workOrders) {
    store.markWorkOrderFetched(workOrder.id, fetchedAt);
  }
  const activeWorkOrders = options.includeActive
    ? store.listActiveWorkOrders(repoId, sessionId)
    : [];
  const seen = new Set<string>();
  return [...workOrders, ...activeWorkOrders].filter((workOrder) => {
    if (seen.has(workOrder.id)) return false;
    seen.add(workOrder.id);
    return true;
  });
}

function syncCoordinationState(
  store: RebaseStore,
  repoId: string,
  createdAt: number,
  rocketRide?: RocketRideCoordinator | undefined
): void {
  if (isRocketRideRequired(rocketRide)) return;

  const result = buildCoordinationEpisodes({
    repoId,
    conflicts: store.listConflicts(repoId),
    agents: store.listAgentSessions(repoId),
    decisions: store.listConflictDecisions(repoId),
    publications: store.listContractPublications(repoId),
    existingEpisodes: store.listCoordinationEpisodes(repoId),
    existingWorkOrders: store.listWorkOrders(repoId),
    createdAt
  });
  const activeEpisodeIds = new Set(result.episodes.map((episode) => episode.id));
  for (const episode of result.episodes) {
    store.upsertCoordinationEpisode(episode);
  }
  for (const episode of store.listCoordinationEpisodes(repoId)) {
    if (episode.status !== "resolved" && !activeEpisodeIds.has(episode.id)) {
      store.upsertCoordinationEpisode({
        ...episode,
        status: "resolved",
        updatedAt: createdAt
      });
    }
  }
  for (const workOrder of result.workOrders) {
    store.upsertWorkOrder(workOrder);
  }
  for (const episode of result.episodes) {
    if (episode.status !== "coordinated") continue;
    for (const conflictId of episode.conflictIds) {
      store.updateConflictStatus(conflictId, "resolved", createdAt);
    }
  }
}

function relevantCoordinationEpisodesForSession(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): CoordinationEpisode[] {
  return store
    .listCoordinationEpisodes(repoId)
    .filter(
      (episode) =>
        episode.status !== "resolved" &&
        episode.affectedAgentSessionIds.includes(sessionId)
    );
}

function mergeRisksForEpisodes(
  store: RebaseStore,
  repoId: string,
  episodes: CoordinationEpisode[]
): MergeRiskAssessment[] {
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  return store
    .listLatestMergeRiskAssessments(repoId)
    .filter((assessment) => episodeIds.has(assessment.episodeId));
}

function isBlockingMergeRisk(assessment: MergeRiskAssessment): boolean {
  return (
    assessment.status === "blocked" ||
    (!assessment.safe && assessment.risk === "high") ||
    assessment.predictedConflicts.some((conflict) => conflict.blocking)
  );
}

function ensureQueuedDirectionsForSession(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): void {
  const session = store
    .listAgentSessions(repoId)
    .find((candidate) => candidate.id === sessionId);
  if (!session?.worktreeId) return;

  const interventions = store.listInterventions(repoId);
  const agents = store.listAgentSessions(repoId);
  const fingerprints = store.listFingerprints(repoId);
  const publications = store.listContractPublications(repoId);
  const createdAt = Date.now();
  let sentOffset = 0;

  for (const conflict of conflictsWithActiveDecisionsForSession(
    store,
    repoId,
    session
  )) {
    const decision = activeDecisionForConflictOrEpisode(store, repoId, conflict);
    if (!decision) continue;

    const relevantPublications = publications
      .filter(
        (publication) =>
          publication.conflictId === conflict.id &&
          publication.ownerAgentSessionId !== session.id
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    if (relevantPublications.length > 0) {
      for (const publication of relevantPublications) {
        if (
          hasInterventionForSession(interventions, {
            conflictId: conflict.id,
            sessionId,
            draft: publication.shapeSummary,
            createdAt: publication.createdAt
          })
        ) {
          continue;
        }
        store.upsertIntervention(
          buildPublicationIntervention({
            repoId,
            conflict,
            publication,
            agent: session,
            ownerSessionId: publication.ownerAgentSessionId,
            agents,
            fingerprints,
            createdAt,
            sentAt: createdAt + sentOffset
          })
        );
        sentOffset += 1;
      }
      continue;
    }

    if (
      hasScopedInterventionForSession(interventions, {
        sessionId,
        draft: decision.selectedOptionDirection,
        createdAt: decision.createdAt
      })
    ) {
      continue;
    }
    store.upsertIntervention(
      buildDecisionIntervention({
        repoId,
        conflict,
        decision,
        agent: session,
        agents,
        fingerprints,
        createdAt,
        sentAt: createdAt + sentOffset
      })
    );
    sentOffset += 1;
  }
}

function hasInterventionForSession(
  interventions: Intervention[],
  input: {
    conflictId: string;
    sessionId: string;
    draft: string;
    createdAt: number;
  }
): boolean {
  return interventions.some(
    (intervention) =>
      intervention.conflictId === input.conflictId &&
      intervention.createdAt >= input.createdAt &&
      intervention.draft === input.draft &&
      intervention.targetAgentSessionIds.includes(input.sessionId)
  );
}

function hasScopedInterventionForSession(
  interventions: Intervention[],
  input: {
    sessionId: string;
    draft: string;
    createdAt: number;
  }
): boolean {
  return interventions.some(
    (intervention) =>
      intervention.createdAt >= input.createdAt &&
      intervention.draft === input.draft &&
      intervention.targetAgentSessionIds.includes(input.sessionId)
  );
}

function conflictsForSession(
  store: RebaseStore,
  repoId: string,
  session: AgentSession
): RebaseConflict[] {
  if (!session.worktreeId) return [];
  return store
    .listConflicts(repoId)
    .filter(
      (conflict) =>
        conflict.status === "open" &&
        session.worktreeId !== null &&
        conflict.affectedWorktreeIds.includes(session.worktreeId)
    );
}

function choicesForSession(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): ConflictChoiceBrief[] {
  const session = store
    .listAgentSessions(repoId)
    .find((candidate) => candidate.id === sessionId);
  if (!session) return [];
  return choicesForConflicts(
    conflictsForSession(store, repoId, session).filter(
      (conflict) =>
        conflict.classification?.kind !== "coordination_notice" &&
        !isIntegrationConflict(store, repoId, conflict) &&
        !activeDecisionForConflictOrEpisode(store, repoId, conflict)
    )
  );
}

function choicesForConflicts(conflicts: RebaseConflict[]): ConflictChoiceBrief[] {
  return conflicts.map((conflict) => ({
    conflictId: conflict.id,
    title: conflict.title,
    summary: conflict.summary,
    risk: conflict.risk,
    options: createHeuristicAdvisory(conflict).options.map((option) => ({
      id: option.id,
      title: option.title,
      direction: option.direction,
      rationale: option.rationale
    }))
  }));
}

function isBlockingConflict(conflict: RebaseConflict): boolean {
  return (
    conflict.debate?.verdict === "blocking" ||
    conflict.classification?.kind === "blocking_conflict" ||
    conflict.risk === "high"
  );
}

const ENFORCED_CONTRACT_TERMS = [
  "label",
  "project",
  "subtitle",
  "reminderAt",
  "archived",
  "batchId"
];

interface WorkOrderEvaluation {
  workOrder: WorkOrder;
  satisfied: boolean;
  missingTerms: string[];
}

function evaluateWorkOrdersForCheckpoint(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
  workOrders: WorkOrder[];
  coordinationEpisodes: CoordinationEpisode[];
  evaluatedAt: number;
}): WorkOrderEvaluation[] {
  return input.workOrders
    .filter((workOrder) => workOrder.status !== "completed")
    .filter((workOrder) => {
      const episode = input.coordinationEpisodes.find(
        (candidate) => candidate.id === workOrder.episodeId
      );
      return !(
        episode &&
        isIntegrationEpisode(input.store, input.repoId, episode) &&
        workOrder.role !== "integration_owner"
      );
    })
    .map((workOrder) => {
      const episode = input.coordinationEpisodes.find(
        (candidate) => candidate.id === workOrder.episodeId
      );
      const evaluation = evaluateWorkOrder({
        store: input.store,
        repoId: input.repoId,
        session: input.session,
        workOrder,
        episode
      });
      if (evaluation.satisfied) {
        input.store.markWorkOrderCompleted(workOrder.id, input.evaluatedAt);
      }
      return evaluation;
    });
}

function isIntegrationEpisode(
  store: RebaseStore,
  repoId: string,
  episode: CoordinationEpisode
): boolean {
  const conflicts = store
    .listConflicts(repoId)
    .filter((conflict) => episode.conflictIds.includes(conflict.id));
  return conflicts.some((conflict) => isIntegrationConflict(store, repoId, conflict));
}

function evaluateWorkOrder(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
  workOrder: WorkOrder;
  episode?: CoordinationEpisode | undefined;
}): WorkOrderEvaluation {
  const blockedFiles = blockedFileViolations({
    store: input.store,
    repoId: input.repoId,
    session: input.session,
    workOrder: input.workOrder
  });
  if (blockedFiles.length > 0) {
    return {
      workOrder: input.workOrder,
      satisfied: false,
      missingTerms: [`blocked files touched: ${blockedFiles.join(", ")}`]
    };
  }

  if (input.workOrder.role === "integration_owner") {
    const latestRisk = input.store
      .listLatestMergeRiskAssessments(input.repoId)
      .find((assessment) => assessment.episodeId === input.workOrder.episodeId);
    const safe =
      latestRisk?.safe === true &&
      latestRisk.status === "safe" &&
      latestRisk.predictedConflicts.every((conflict) => !conflict.blocking);
    return {
      workOrder: input.workOrder,
      satisfied: safe,
      missingTerms: safe ? [] : ["safe merge risk"]
    };
  }

  if (input.workOrder.role === "contract_owner") {
    const ownerPublished = input.episode
      ? hasOwnerPublicationForEpisode({
          store: input.store,
          repoId: input.repoId,
          sessionId: input.session.id,
          episode: input.episode
        })
      : false;
    const satisfied = Boolean(input.episode?.mergeContract || ownerPublished);
    return {
      workOrder: input.workOrder,
      satisfied,
      missingTerms: satisfied ? [] : ["published contract"]
    };
  }

  const requiredTerms = ENFORCED_CONTRACT_TERMS.filter((term) =>
    input.workOrder.requiredContract?.includes(term)
  );
  if (requiredTerms.length === 0) {
    return { workOrder: input.workOrder, satisfied: true, missingTerms: [] };
  }

  const evidence = latestFingerprintEvidence({
    store: input.store,
    repoId: input.repoId,
    session: input.session
  });
  const missingTerms = requiredTerms.filter((term) => !evidence.includes(term));
  return {
    workOrder: input.workOrder,
    satisfied: missingTerms.length === 0,
    missingTerms
  };
}

function hasOwnerPublicationForEpisode(input: {
  store: RebaseStore;
  repoId: string;
  sessionId: string;
  episode: CoordinationEpisode;
}): boolean {
  const conflictIds = new Set(input.episode.conflictIds);
  return input.store
    .listContractPublications(input.repoId)
    .some(
      (publication) =>
        publication.ownerAgentSessionId === input.sessionId &&
        conflictIds.has(publication.conflictId)
    );
}

function latestFingerprintEvidence(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
}): string {
  if (!input.session.worktreeId) return "";
  const fingerprint = input.store
    .listFingerprints(input.repoId)
    .filter((candidate) => candidate.worktreeId === input.session.worktreeId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!fingerprint) return "";
  return [
    fingerprint.semanticSummary,
    ...fingerprint.contractChanges,
    ...fingerprint.surfaces.flatMap((surface) => [
      surface.label,
      ...surface.evidence
    ]),
    ...fingerprint.symbols.added,
    ...fingerprint.symbols.modified
  ].join("\n");
}

function blockedFileViolations(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
  workOrder: WorkOrder;
}): string[] {
  if (input.workOrder.blockedFiles.length === 0) return [];
  const touchedFiles = touchedFilesForSession(input);
  return touchedFiles.filter((file) =>
    input.workOrder.blockedFiles.some((pattern) => pathPatternMatches(pattern, file))
  );
}

function touchedFilesForSession(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
}): string[] {
  const files = new Set<string>();
  if (input.session.worktreeId) {
    const fingerprint = input.store
      .listFingerprints(input.repoId)
      .filter((candidate) => candidate.worktreeId === input.session.worktreeId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    for (const file of fingerprint?.filesTouched ?? []) {
      files.add(file);
    }
  }

  for (const file of gitChangedFiles(input.session.cwd)) {
    files.add(file);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function gitChangedFiles(cwd: string): string[] {
  try {
    const diff = execFileSync("git", ["-C", cwd, "diff", "--name-only"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const untracked = execFileSync(
      "git",
      ["-C", cwd, "ls-files", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    return [...diff.split("\n"), ...untracked.split("\n")]
      .map((file) => file.trim())
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function pathPatternMatches(pattern: string, file: string): boolean {
  if (pattern === file) return true;
  if (pattern.endsWith("/**")) {
    return file.startsWith(pattern.slice(0, -2));
  }
  if (pattern.endsWith("*")) {
    return file.startsWith(pattern.slice(0, -1));
  }
  return false;
}

function coordinationEpisodeForConflict(
  store: RebaseStore,
  repoId: string,
  conflictId: string
): CoordinationEpisode | undefined {
  return store
    .listCoordinationEpisodes(repoId)
    .filter((episode) => episode.status !== "resolved")
    .find((episode) => episode.conflictIds.includes(conflictId));
}

function activeDecisionForConflictOrEpisode(
  store: RebaseStore,
  repoId: string,
  conflict: RebaseConflict
): ConflictDecision | null {
  const episode = coordinationEpisodeForConflict(store, repoId, conflict.id);
  const scopedConflictIds = new Set(episode?.conflictIds ?? [conflict.id]);
  const decisions = store
    .listConflictDecisions(repoId)
    .filter(
      (decision) =>
        decision.status === "active" && scopedConflictIds.has(decision.conflictId)
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    );
  return decisions[0] ?? null;
}

function activeDecisionBriefsForSession(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): ActiveDecisionBrief[] {
  const session = store
    .listAgentSessions(repoId)
    .find((candidate) => candidate.id === sessionId);
  if (!session) return [];
  return activeDecisionBriefsForConflicts(
    store,
    conflictsForSession(store, repoId, session).filter(
      (conflict) => conflict.classification?.kind !== "coordination_notice"
    )
  );
}

function activeDecisionBriefsForConflicts(
  store: RebaseStore,
  conflicts: RebaseConflict[]
): ActiveDecisionBrief[] {
  const seen = new Set<string>();
  return conflicts.flatMap((conflict) => {
    const decision = activeDecisionForConflictOrEpisode(
      store,
      conflict.repoId,
      conflict
    );
    if (!decision) return [];
    if (seen.has(decision.id)) return [];
    seen.add(decision.id);
    return [
      {
        conflictId: decision.conflictId,
        selectedOptionTitle: decision.selectedOptionTitle,
        selectedOptionDirection: decision.selectedOptionDirection,
        ...(decision.ownerAgentSessionId
          ? { ownerAgentSessionId: decision.ownerAgentSessionId }
          : {}),
        createdBy: decision.createdBy
      }
    ];
  });
}

function isIntegrationConflict(
  store: RebaseStore,
  repoId: string,
  conflict: RebaseConflict
): boolean {
  const affectedWorktrees = new Set(conflict.affectedWorktreeIds);
  return store
    .listAgentSessions(repoId)
    .some(
      (agent) =>
        agent.coordinationRole === "integration" &&
        agent.worktreeId !== null &&
        affectedWorktrees.has(agent.worktreeId)
    );
}

function isSplitOwnershipDecision(input: RecordDecisionInput): boolean {
  const normalizedId = input.selectedOptionId.toLowerCase();
  const normalizedTitle = input.selectedOptionTitle.toLowerCase();
  return (
    normalizedId.includes("split-ownership") ||
    normalizedTitle === "split ownership"
  );
}

function queueDecisionInterventions({
  store,
  repoId,
  conflict,
  episode,
  decision,
  createdAt
}: {
  store: RebaseStore;
  repoId: string;
  conflict: RebaseConflict;
  episode?: CoordinationEpisode | undefined;
  decision: ConflictDecision;
  createdAt: number;
}): Intervention[] {
  const agents = store.listAgentSessions(repoId);
  const fingerprints = store.listFingerprints(repoId);
  const episodeAgentIds = episode
    ? new Set(episode.affectedAgentSessionIds)
    : null;
  const targetAgents = agents.filter(
    (agent) =>
      agent.worktreeId !== null &&
      (episodeAgentIds
        ? episodeAgentIds.has(agent.id)
        : conflict.affectedWorktreeIds.includes(agent.worktreeId))
  );
  const interventions = targetAgents.map((agent, index) =>
    buildDecisionIntervention({
      repoId,
      conflict,
      decision,
      agent,
      agents,
      fingerprints,
      createdAt,
      sentAt: createdAt + index
    })
  );
  for (const intervention of interventions) {
    store.upsertIntervention(intervention);
  }
  return interventions;
}

function buildDecisionIntervention({
  repoId,
  conflict,
  decision,
  agent,
  agents,
  fingerprints,
  createdAt,
  sentAt
}: {
  repoId: string;
  conflict: RebaseConflict;
  decision: ConflictDecision;
  agent: AgentSession;
  agents: AgentSession[];
  fingerprints: Fingerprint[];
  createdAt: number;
  sentAt: number;
}): Intervention {
  const directive = buildAgentSpecificDirective({
    conflict,
    targetSessionId: agent.id,
    ownerSessionId: decision.ownerAgentSessionId,
    agents,
    fingerprints,
    editedDirection: decision.selectedOptionDirection
  });
  const editedDirection = decision.ownerAgentSessionId
    ? directionFromDirective(directive, decision.selectedOptionDirection)
    : decision.selectedOptionDirection;
  return {
    id: nanoid(16),
    repoId,
    conflictId: conflict.id,
    targetAgentSessionIds: [agent.id],
    draft: decision.selectedOptionDirection,
    editedDirection,
    directive,
    status: "queued" as const,
    createdAt,
    sentAt
  };
}

function publishContractShape({
  store,
  repoId,
  session,
  input,
  createdAt
}: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
  input: PublishContractInput;
  createdAt: number;
}): ContractPublication {
  const conflict = resolvePublicationConflict({
    store,
    repoId,
    session,
    input
  });
  if (!conflict) {
    const candidates = publicationConflictCandidates({ store, repoId, session });
    throw new Error(
      candidates.length > 0
        ? `Conflict ${input.conflictId ?? "(not provided)"} not found. Active conflict ids for this session: ${candidates
            .map((candidate) => candidate.id)
            .join(", ")}.`
      : `Conflict ${input.conflictId ?? "(not provided)"} not found. No active coordination episode matches this session.`
    );
  }
  const episode = publicationEpisodeForConflict({
    store,
    repoId,
    sessionId: session.id,
    conflictId: conflict.id
  });
  const decision = activeDecisionForConflictOrEpisode(store, repoId, conflict);
  if (decision?.ownerAgentSessionId && decision.ownerAgentSessionId !== session.id) {
    throw new Error("Only the assigned contract owner can publish this shape");
  }

  const publication: ContractPublication = {
    id: nanoid(16),
    repoId,
    conflictId: conflict.id,
    ownerAgentSessionId: session.id,
    surface: input.surface,
    shapeSummary: input.shapeSummary,
    files: input.files ?? [],
    createdAt
  };
  store.upsertContractPublication(publication);
  store.addEvent({
    id: nanoid(16),
    repoId,
    type: "contract.published",
    message: `${session.displayName} published ${publication.surface}`,
    payload: {
      conflictId: conflict.id,
      ownerAgentSessionId: session.id,
      files: publication.files
    },
    createdAt
  });
  queuePublicationInterventions({
    store,
    repoId,
    conflict,
    episode,
    publication,
    ownerSessionId: session.id,
    createdAt
  });
  return publication;
}

function resolvePublicationConflict(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
  input: PublishContractInput;
}): RebaseConflict | undefined {
  if (input.input.conflictId) {
    return input.store
      .listConflicts(input.repoId)
      .find((candidate) => candidate.id === input.input.conflictId);
  }
  const candidates = publicationConflictCandidates(input);
  const matchingSurface = candidates.filter(
    (candidate) =>
      candidate.primarySurface === input.input.surface ||
      candidate.affectedSurfaces.includes(input.input.surface)
  );
  const scoped = matchingSurface.length > 0 ? matchingSurface : candidates;
  if (scoped.length === 1) return scoped[0];

  const scopedIds = new Set(scoped.map((candidate) => candidate.id));
  const matchingEpisodes = relevantCoordinationEpisodesForSession(
    input.store,
    input.repoId,
    input.session.id
  ).filter(
    (episode) =>
      (!episode.ownerAgentSessionId ||
        episode.ownerAgentSessionId === input.session.id) &&
      episode.conflictIds.some((conflictId) => scopedIds.has(conflictId))
  );
  if (matchingEpisodes.length !== 1) return undefined;

  return preferredPublicationConflict({
    store: input.store,
    repoId: input.repoId,
    sessionId: input.session.id,
    conflicts: scoped.filter((candidate) =>
      matchingEpisodes[0]?.conflictIds.includes(candidate.id)
    )
  });
}

function preferredPublicationConflict(input: {
  store: RebaseStore;
  repoId: string;
  sessionId: string;
  conflicts: RebaseConflict[];
}): RebaseConflict | undefined {
  const ownedDecisionConflictIds = new Set(
    input.store
      .listConflictDecisions(input.repoId)
      .filter(
        (decision) =>
          decision.status === "active" &&
          decision.ownerAgentSessionId === input.sessionId
      )
      .map((decision) => decision.conflictId)
  );
  return [...input.conflicts].sort((left, right) => {
    const leftOwned = ownedDecisionConflictIds.has(left.id) ? 1 : 0;
    const rightOwned = ownedDecisionConflictIds.has(right.id) ? 1 : 0;
    return rightOwned - leftOwned || left.id.localeCompare(right.id);
  })[0];
}

function publicationEpisodeForConflict(input: {
  store: RebaseStore;
  repoId: string;
  sessionId: string;
  conflictId: string;
}): CoordinationEpisode | undefined {
  return relevantCoordinationEpisodesForSession(
    input.store,
    input.repoId,
    input.sessionId
  ).find((episode) => episode.conflictIds.includes(input.conflictId));
}

function publicationConflictCandidates(input: {
  store: RebaseStore;
  repoId: string;
  session: AgentSession;
}): RebaseConflict[] {
  const sessionEpisodes = relevantCoordinationEpisodesForSession(
    input.store,
    input.repoId,
    input.session.id
  ).filter(
    (episode) =>
      !episode.ownerAgentSessionId || episode.ownerAgentSessionId === input.session.id
  );
  const activeConflictIds = new Set(
    sessionEpisodes.flatMap((episode) => episode.conflictIds)
  );
  return input.store
    .listConflicts(input.repoId)
    .filter(
      (conflict) =>
        conflict.status === "open" &&
        activeConflictIds.has(conflict.id) &&
        (!input.session.worktreeId ||
          conflict.affectedWorktreeIds.includes(input.session.worktreeId))
    );
}

function queuePublicationInterventions({
  store,
  repoId,
  conflict,
  episode,
  publication,
  ownerSessionId,
  createdAt
}: {
  store: RebaseStore;
  repoId: string;
  conflict: RebaseConflict;
  episode?: CoordinationEpisode | undefined;
  publication: ContractPublication;
  ownerSessionId: string;
  createdAt: number;
}): Intervention[] {
  const agents = store.listAgentSessions(repoId);
  const fingerprints = store.listFingerprints(repoId);
  const episodeAgentIds = episode
    ? new Set(episode.affectedAgentSessionIds)
    : null;
  const targets = agents.filter(
    (agent) =>
      agent.id !== ownerSessionId &&
      agent.worktreeId !== null &&
      (episodeAgentIds
        ? episodeAgentIds.has(agent.id)
        : conflict.affectedWorktreeIds.includes(agent.worktreeId))
  );
  const interventions = targets.map((agent, index) =>
    buildPublicationIntervention({
      repoId,
      conflict,
      publication,
      agent,
      ownerSessionId,
      agents,
      fingerprints,
      createdAt,
      sentAt: createdAt + index
    })
  );
  for (const intervention of interventions) {
    store.upsertIntervention(intervention);
  }
  return interventions;
}

function buildPublicationIntervention({
  repoId,
  conflict,
  publication,
  agent,
  ownerSessionId,
  agents,
  fingerprints,
  createdAt,
  sentAt
}: {
  repoId: string;
  conflict: RebaseConflict;
  publication: ContractPublication;
  agent: AgentSession;
  ownerSessionId: string;
  agents: AgentSession[];
  fingerprints: Fingerprint[];
  createdAt: number;
  sentAt: number;
}): Intervention {
  const directive = buildAgentSpecificDirective({
    conflict,
    targetSessionId: agent.id,
    ownerSessionId,
    agents,
    fingerprints,
    editedDirection: publication.shapeSummary
  });
  const editedDirection = [
    `Owner published ${publication.surface}: ${publication.shapeSummary}`,
    publication.files.length > 0
      ? `Contract files: ${publication.files.join(", ")}.`
      : null,
    "Preserve this shape while adapting local feature code, then checkpoint."
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: nanoid(16),
    repoId,
    conflictId: conflict.id,
    targetAgentSessionIds: [agent.id],
    draft: publication.shapeSummary,
    editedDirection,
    directive,
    status: "queued" as const,
    createdAt,
    sentAt
  };
}

function waitingForOwnerPublication(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): WaitingOnBrief | null {
  const session = store
    .listAgentSessions(repoId)
    .find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  const publications = store.listContractPublications(repoId);
  for (const conflict of conflictsWithActiveDecisionsForSession(
    store,
    repoId,
    session
  )) {
    const decision = activeDecisionForConflictOrEpisode(store, repoId, conflict);
    if (!decision?.ownerAgentSessionId) continue;
    if (decision.ownerAgentSessionId === sessionId) continue;
    const episode = coordinationEpisodeForConflict(store, repoId, conflict.id);
    const publicationConflictIds = new Set(episode?.conflictIds ?? [conflict.id]);
    if (
      publications.some((publication) =>
        publicationConflictIds.has(publication.conflictId)
      )
    ) {
      continue;
    }
    return {
      type: "owner_contract_publication",
      conflictId: conflict.id,
      ownerAgentSessionId: decision.ownerAgentSessionId
    };
  }
  return null;
}

function relevantPublicationsForSession(
  store: RebaseStore,
  repoId: string,
  sessionId: string
): ContractPublication[] {
  const session = store
    .listAgentSessions(repoId)
    .find((candidate) => candidate.id === sessionId);
  if (!session) return [];
  const conflictIds = new Set(
    conflictsWithActiveDecisionsForSession(store, repoId, session).map(
      (conflict) => conflict.id
    )
  );
  for (const episode of relevantCoordinationEpisodesForSession(
    store,
    repoId,
    sessionId
  )) {
    for (const conflictId of episode.conflictIds) {
      conflictIds.add(conflictId);
    }
  }
  return store
    .listContractPublications(repoId)
    .filter((publication) => conflictIds.has(publication.conflictId));
}

function conflictsWithActiveDecisionsForSession(
  store: RebaseStore,
  repoId: string,
  session: AgentSession
): RebaseConflict[] {
  if (!session.worktreeId) return [];
  const seenDecisionIds = new Set<string>();
  return store
    .listConflicts(repoId)
    .filter((conflict) => {
      if (!conflict.affectedWorktreeIds.includes(session.worktreeId ?? "")) {
        return false;
      }
      const decision = activeDecisionForConflictOrEpisode(store, repoId, conflict);
      if (!decision || seenDecisionIds.has(decision.id)) return false;
      seenDecisionIds.add(decision.id);
      return true;
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function highestRisk(risks: RiskLevel[]): RiskLevel {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}
