import type {
  AgentSession,
  CoordinationRole,
  ConflictDecision,
  ContractPublication,
  Fingerprint,
  Intervention,
  RiskLevel,
  RebaseConflict
} from "@rebase/shared";
import { nanoid } from "nanoid";
import { createHeuristicAdvisory } from "./advisory.js";
import {
  buildAgentSpecificDirective,
  directionFromDirective
} from "./guidance.js";
import { upsertAgentGraph } from "./graph.js";
import { worktreeIdFor } from "./ids.js";
import type { RebaseStore } from "./store.js";

export interface McpToolContext {
  repoId: string;
  repoRoot: string;
  store: RebaseStore;
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
  conflictId: string;
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
          activeDecisions: [],
          publications: [],
          keepWaiting: false,
          pause: false
        };
      }
      context.store.updateAgentCheckpoint(input.sessionId, checkpointAt);

      const publication = input.publishContract
        ? publishContractShape({
            store: context.store,
            repoId: context.repoId,
            session,
            input: input.publishContract,
            createdAt: checkpointAt
          })
        : null;

      ensureQueuedDirectionsForSession(context.store, context.repoId, input.sessionId);
      const directions = deliverQueuedDirections(
        context.store,
        context.repoId,
        input.sessionId
      );
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
      const unresolvedConflicts = blockingConflicts.filter(
        (conflict) => !context.store.getActiveConflictDecision(conflict.id)
      );
      const activeDecisions = activeDecisionBriefsForConflicts(
        context.store,
        blockingConflicts
      );
      const risk = highestRisk(unresolvedConflicts.map((conflict) => conflict.risk));
      const notifications = unresolvedConflicts.map(
        (conflict) =>
          `${conflict.risk.toUpperCase()} risk: ${conflict.title}. ${conflict.summary}`
      );
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
        keepWaiting: unresolvedConflicts.some(isBlockingConflict),
        pause: unresolvedConflicts.some(isBlockingConflict)
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
        )
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
      ensureQueuedDirectionsForSession(context.store, context.repoId, input.sessionId);
      return {
        directions: deliverQueuedDirections(
          context.store,
          context.repoId,
          input.sessionId
        )
      };
    },

    recordDecision(input: RecordDecisionInput): RecordDecisionResult {
      const existing = context.store.getActiveConflictDecision(input.conflictId);
      if (existing) {
        return {
          decision: existing,
          interventions: [],
          alreadyDecided: true
        };
      }
      const conflict = context.store
        .listConflicts(context.repoId)
        .find((candidate) => candidate.id === input.conflictId);
      if (!conflict) {
        throw new Error(`Conflict ${input.conflictId} not found`);
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
        ensureQueuedDirectionsForSession(context.store, context.repoId, input.sessionId);
        const directions = deliverQueuedDirections(
          context.store,
          context.repoId,
          input.sessionId
        );
        if (directions.length > 0) {
          return {
            directions,
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
    const decision = store.getActiveConflictDecision(conflict.id);
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
      hasInterventionForSession(interventions, {
        conflictId: conflict.id,
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
        !store.getActiveConflictDecision(conflict.id)
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
  return conflicts.flatMap((conflict) => {
    const decision = store.getActiveConflictDecision(conflict.id);
    if (!decision) return [];
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
  decision,
  createdAt
}: {
  store: RebaseStore;
  repoId: string;
  conflict: RebaseConflict;
  decision: ConflictDecision;
  createdAt: number;
}): Intervention[] {
  const agents = store.listAgentSessions(repoId);
  const fingerprints = store.listFingerprints(repoId);
  const targetAgents = agents.filter(
    (agent) =>
      agent.worktreeId !== null && conflict.affectedWorktreeIds.includes(agent.worktreeId)
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
  const conflict = store
    .listConflicts(repoId)
    .find((candidate) => candidate.id === input.conflictId);
  if (!conflict) {
    throw new Error(`Conflict ${input.conflictId} not found`);
  }
  const decision = store.getActiveConflictDecision(conflict.id);
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
    publication,
    ownerSessionId: session.id,
    createdAt
  });
  return publication;
}

function queuePublicationInterventions({
  store,
  repoId,
  conflict,
  publication,
  ownerSessionId,
  createdAt
}: {
  store: RebaseStore;
  repoId: string;
  conflict: RebaseConflict;
  publication: ContractPublication;
  ownerSessionId: string;
  createdAt: number;
}): Intervention[] {
  const agents = store.listAgentSessions(repoId);
  const fingerprints = store.listFingerprints(repoId);
  const targets = agents.filter(
    (agent) =>
      agent.id !== ownerSessionId &&
      agent.worktreeId !== null &&
      conflict.affectedWorktreeIds.includes(agent.worktreeId)
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
    const decision = store.getActiveConflictDecision(conflict.id);
    if (!decision?.ownerAgentSessionId) continue;
    if (decision.ownerAgentSessionId === sessionId) continue;
    if (publications.some((publication) => publication.conflictId === conflict.id)) {
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
  const decisionsByConflictId = new Map(
    store
      .listConflictDecisions(repoId)
      .filter((decision) => decision.status === "active")
      .map((decision) => [decision.conflictId, decision])
  );
  return store
    .listConflicts(repoId)
    .filter(
      (conflict) =>
        decisionsByConflictId.has(conflict.id) &&
        conflict.affectedWorktreeIds.includes(session.worktreeId ?? "")
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function highestRisk(risks: RiskLevel[]): RiskLevel {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}
