import Database from "better-sqlite3";
import type {
  AgentSession,
  Advisory,
  CloudEscalationPacket,
  CoordinationEpisode,
  ConflictDecision,
  ConflictStatus,
  ContractPublication,
  EvidencePacket,
  Fingerprint,
  HookEvent,
  Intervention,
  MergeRiskAssessment,
  RebaseConflict,
  RebaseEvent,
  RebaseGraphEdge,
  RebaseGraphNode,
  RebaseRepo,
  RebaseWorktree,
  WorkOrder
} from "@rebase/shared";
import {
  agentSessionSchema,
  advisorySchema,
  cloudEscalationPacketSchema,
  coordinationEpisodeSchema,
  conflictDecisionSchema,
  conflictSchema,
  contractPublicationSchema,
  evidencePacketSchema,
  eventSchema,
  fingerprintSchema,
  graphEdgeSchema,
  graphNodeSchema,
  hookEventSchema,
  interventionSchema,
  mergeRiskAssessmentSchema,
  repoSchema,
  workOrderSchema,
  worktreeSchema
} from "@rebase/shared";

export interface RebaseStore {
  upsertRepo(repo: RebaseRepo): void;
  getRepo(repoId: string): RebaseRepo | null;
  upsertWorktree(worktree: RebaseWorktree): void;
  markMissingWorktrees(repoId: string, activeWorktreeIds: string[], observedAt: number): void;
  listWorktrees(repoId: string): RebaseWorktree[];
  addEvent(event: RebaseEvent): void;
  listEvents(repoId: string): RebaseEvent[];
  upsertHookEvent(event: HookEvent): void;
  listHookEvents(repoId: string, sessionId?: string): HookEvent[];
  upsertEvidencePacket(packet: EvidencePacket): void;
  listEvidencePackets(repoId: string): EvidencePacket[];
  pruneExpiredEvidence(now: number): number;
  upsertCloudEscalationPacket(packet: CloudEscalationPacket): void;
  listCloudEscalationPackets(repoId: string): CloudEscalationPacket[];
  upsertGraphNode(node: RebaseGraphNode): void;
  upsertGraphEdge(edge: RebaseGraphEdge): void;
  listGraphNodes(repoId: string): RebaseGraphNode[];
  listGraphEdges(repoId: string): RebaseGraphEdge[];
  upsertFingerprint(fingerprint: Fingerprint): void;
  listFingerprints(repoId: string): Fingerprint[];
  upsertAgentSession(session: AgentSession): void;
  listAgentSessions(repoId: string): AgentSession[];
  updateAgentPlan(sessionId: string, plan: string, updatedAt: number): void;
  updateAgentCheckpoint(sessionId: string, updatedAt: number): void;
  upsertConflict(conflict: RebaseConflict): void;
  listConflicts(repoId: string): RebaseConflict[];
  updateConflictStatus(id: string, status: ConflictStatus, updatedAt: number): void;
  upsertCoordinationEpisode(episode: CoordinationEpisode): void;
  listCoordinationEpisodes(repoId: string): CoordinationEpisode[];
  upsertMergeRiskAssessment(assessment: MergeRiskAssessment): void;
  listMergeRiskAssessments(repoId: string): MergeRiskAssessment[];
  listLatestMergeRiskAssessments(repoId: string): MergeRiskAssessment[];
  upsertWorkOrder(workOrder: WorkOrder): void;
  listWorkOrders(repoId: string): WorkOrder[];
  listQueuedWorkOrders(repoId: string, agentSessionId: string): WorkOrder[];
  listActiveWorkOrders(repoId: string, agentSessionId: string): WorkOrder[];
  markWorkOrderFetched(id: string, fetchedAt: number): void;
  markWorkOrderAcknowledged(id: string, acknowledgedAt: number): void;
  markWorkOrderCompleted(id: string, completedAt: number): void;
  upsertConflictDecision(decision: ConflictDecision): void;
  getActiveConflictDecision(conflictId: string): ConflictDecision | null;
  listConflictDecisions(repoId: string): ConflictDecision[];
  upsertAdvisory(advisory: Advisory): void;
  listAdvisories(repoId: string): Advisory[];
  upsertContractPublication(publication: ContractPublication): void;
  listContractPublications(repoId: string): ContractPublication[];
  upsertIntervention(intervention: Intervention): void;
  listInterventions(repoId: string): Intervention[];
  listQueuedInterventions(repoId: string, agentSessionId: string): Intervention[];
  markInterventionFetched(id: string, fetchedAt: number): void;
  markInterventionAcknowledged(id: string, acknowledgedAt: number): void;
  close(): void;
}

export function createRebaseStore(dbPath: string): RebaseStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return new BetterSqliteRebaseStore(db);
}

class BetterSqliteRebaseStore implements RebaseStore {
  constructor(private readonly db: Database.Database) {}

  upsertRepo(repo: RebaseRepo): void {
    const parsed = repoSchema.parse(repo);
    this.db
      .prepare(
        `
        insert into repos (id, root_path, name, created_at, updated_at)
        values (@id, @rootPath, @name, @createdAt, @updatedAt)
        on conflict(id) do update set
          root_path = excluded.root_path,
          name = excluded.name,
          updated_at = excluded.updated_at
      `
      )
      .run(parsed);
  }

  getRepo(repoId: string): RebaseRepo | null {
    const row = this.db.prepare("select * from repos where id = ?").get(repoId);
    if (!row) return null;
    return repoSchema.parse(repoFromRow(row as RepoRow));
  }

  upsertWorktree(worktree: RebaseWorktree): void {
    const parsed = worktreeSchema.parse(worktree);
    this.db
      .prepare(
        `
        insert into worktrees (
          id, repo_id, path, branch, head_sha, dirty, status, last_observed_at
        )
        values (
          @id, @repoId, @path, @branch, @headSha, @dirty, @status, @lastObservedAt
        )
        on conflict(repo_id, path) do update set
          branch = excluded.branch,
          head_sha = excluded.head_sha,
          dirty = excluded.dirty,
          status = excluded.status,
          last_observed_at = excluded.last_observed_at
      `
      )
      .run({
        ...parsed,
        dirty: parsed.dirty ? 1 : 0
      });
  }

  markMissingWorktrees(
    repoId: string,
    activeWorktreeIds: string[],
    observedAt: number
  ): void {
    const existing = this.listWorktrees(repoId);
    const activeIds = new Set(activeWorktreeIds);
    const markMissing = this.db.prepare(
      "update worktrees set status = 'missing', dirty = 0, last_observed_at = ? where repo_id = ? and id = ?"
    );
    for (const worktree of existing) {
      if (!activeIds.has(worktree.id) && worktree.status !== "missing") {
        markMissing.run(observedAt, repoId, worktree.id);
      }
    }
  }

  listWorktrees(repoId: string): RebaseWorktree[] {
    const rows = this.db
      .prepare("select * from worktrees where repo_id = ? order by path asc")
      .all(repoId) as WorktreeRow[];
    return rows.map((row) => worktreeSchema.parse(worktreeFromRow(row)));
  }

  addEvent(event: RebaseEvent): void {
    const parsed = eventSchema.parse(event);
    this.db
      .prepare(
        `
        insert or ignore into events (id, repo_id, type, message, payload_json, created_at)
        values (@id, @repoId, @type, @message, @payloadJson, @createdAt)
      `
      )
      .run({ ...parsed, payloadJson: JSON.stringify(parsed.payload) });
  }

  listEvents(repoId: string): RebaseEvent[] {
    const rows = this.db
      .prepare("select * from events where repo_id = ? order by created_at asc")
      .all(repoId) as EventRow[];
    return rows.map((row) => eventSchema.parse(eventFromRow(row)));
  }

  upsertHookEvent(event: HookEvent): void {
    const parsed = hookEventSchema.parse(event);
    this.db
      .prepare(
        `
        insert or ignore into hook_events (
          id, repo_id, session_id, worktree_id, agent_kind, cwd, kind,
          received_at, prompt, tool_name, command, outcome, file_paths_json,
          metadata_json
        )
        values (
          @id, @repoId, @sessionId, @worktreeId, @agentKind, @cwd, @kind,
          @receivedAt, @prompt, @toolName, @command, @outcome,
          @filePathsJson, @metadataJson
        )
      `
      )
      .run({
        ...parsed,
        prompt: parsed.prompt ?? null,
        toolName: parsed.toolName ?? null,
        command: parsed.command ?? null,
        outcome: parsed.outcome ?? null,
        filePathsJson: JSON.stringify(parsed.filePaths),
        metadataJson: JSON.stringify(parsed.metadata)
      });
  }

  listHookEvents(repoId: string, sessionId?: string): HookEvent[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            "select * from hook_events where repo_id = ? and session_id = ? order by received_at asc"
          )
          .all(repoId, sessionId) as HookEventRow[])
      : (this.db
          .prepare(
            "select * from hook_events where repo_id = ? order by received_at asc"
          )
          .all(repoId) as HookEventRow[]);
    return rows.map((row) => hookEventSchema.parse(hookEventFromRow(row)));
  }

  upsertEvidencePacket(packet: EvidencePacket): void {
    const parsed = evidencePacketSchema.parse(packet);
    this.db
      .prepare(
        `
        insert into evidence_packets (
          id, repo_id, session_id, worktree_id, created_at, updated_at,
          expires_at, source, prompt_summary, plan_summary, hook_events_json,
          git_json, surfaces_json, decision_history_json, privacy_json
        )
        values (
          @id, @repoId, @sessionId, @worktreeId, @createdAt, @updatedAt,
          @expiresAt, @source, @promptSummary, @planSummary, @hookEventsJson,
          @gitJson, @surfacesJson, @decisionHistoryJson, @privacyJson
        )
        on conflict(id) do update set
          worktree_id = excluded.worktree_id,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          source = excluded.source,
          prompt_summary = excluded.prompt_summary,
          plan_summary = excluded.plan_summary,
          hook_events_json = excluded.hook_events_json,
          git_json = excluded.git_json,
          surfaces_json = excluded.surfaces_json,
          decision_history_json = excluded.decision_history_json,
          privacy_json = excluded.privacy_json
      `
      )
      .run({
        ...parsed,
        promptSummary: parsed.promptSummary ?? null,
        planSummary: parsed.planSummary ?? null,
        hookEventsJson: JSON.stringify(parsed.hookEvents),
        gitJson: JSON.stringify(parsed.git),
        surfacesJson: JSON.stringify(parsed.surfaces),
        decisionHistoryJson: JSON.stringify(parsed.decisionHistory),
        privacyJson: JSON.stringify(parsed.privacy)
      });
  }

  listEvidencePackets(repoId: string): EvidencePacket[] {
    const rows = this.db
      .prepare(
        "select * from evidence_packets where repo_id = ? order by updated_at desc"
      )
      .all(repoId) as EvidencePacketRow[];
    return rows.map((row) => evidencePacketSchema.parse(evidencePacketFromRow(row)));
  }

  pruneExpiredEvidence(now: number): number {
    const retentionCutoff = now - 3 * 24 * 60 * 60 * 1000;
    this.db
      .prepare(
        "delete from hook_events where received_at <= ? and session_id not in (select session_id from evidence_packets where expires_at > ?)"
      )
      .run(retentionCutoff, now);
    const result = this.db
      .prepare("delete from evidence_packets where expires_at <= ?")
      .run(now);
    return result.changes;
  }

  upsertCloudEscalationPacket(packet: CloudEscalationPacket): void {
    const parsed = cloudEscalationPacketSchema.parse(packet);
    this.db
      .prepare(
        `
        insert into cloud_escalation_packets (
          id, repo_id, conflict_id, evidence_packet_ids_json, provider, reason,
          status, redactions_json, redacted_context_json, created_at, sent_at
        )
        values (
          @id, @repoId, @conflictId, @evidencePacketIdsJson, @provider, @reason,
          @status, @redactionsJson, @redactedContextJson, @createdAt, @sentAt
        )
        on conflict(id) do update set
          conflict_id = excluded.conflict_id,
          evidence_packet_ids_json = excluded.evidence_packet_ids_json,
          provider = excluded.provider,
          reason = excluded.reason,
          status = excluded.status,
          redactions_json = excluded.redactions_json,
          redacted_context_json = excluded.redacted_context_json,
          sent_at = excluded.sent_at
      `
      )
      .run({
        ...parsed,
        conflictId: parsed.conflictId ?? null,
        evidencePacketIdsJson: JSON.stringify(parsed.evidencePacketIds),
        redactionsJson: JSON.stringify(parsed.redactions),
        redactedContextJson: JSON.stringify(parsed.redactedContext),
        sentAt: parsed.sentAt ?? null
      });
  }

  listCloudEscalationPackets(repoId: string): CloudEscalationPacket[] {
    const rows = this.db
      .prepare(
        "select * from cloud_escalation_packets where repo_id = ? order by created_at desc"
      )
      .all(repoId) as CloudEscalationPacketRow[];
    return rows.map((row) =>
      cloudEscalationPacketSchema.parse(cloudEscalationPacketFromRow(row))
    );
  }

  upsertGraphNode(node: RebaseGraphNode): void {
    const parsed = graphNodeSchema.parse(node);
    this.db
      .prepare(
        `
        insert into graph_nodes (id, repo_id, kind, label, ref_id, metadata_json, updated_at)
        values (@id, @repoId, @kind, @label, @refId, @metadataJson, @updatedAt)
        on conflict(id) do update set
          kind = excluded.kind,
          label = excluded.label,
          ref_id = excluded.ref_id,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `
      )
      .run({
        ...parsed,
        refId: parsed.refId ?? null,
        metadataJson: JSON.stringify(parsed.metadata)
      });
  }

  upsertGraphEdge(edge: RebaseGraphEdge): void {
    const parsed = graphEdgeSchema.parse(edge);
    this.db
      .prepare(
        `
        insert into graph_edges (
          id, repo_id, source_id, target_id, kind, metadata_json, updated_at
        )
        values (
          @id, @repoId, @sourceId, @targetId, @kind, @metadataJson, @updatedAt
        )
        on conflict(id) do update set
          kind = excluded.kind,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `
      )
      .run({
        ...parsed,
        metadataJson: JSON.stringify(parsed.metadata)
      });
  }

  listGraphNodes(repoId: string): RebaseGraphNode[] {
    const rows = this.db
      .prepare("select * from graph_nodes where repo_id = ? order by kind asc, label asc")
      .all(repoId) as GraphNodeRow[];
    return rows.map((row) => graphNodeSchema.parse(graphNodeFromRow(row)));
  }

  listGraphEdges(repoId: string): RebaseGraphEdge[] {
    const rows = this.db
      .prepare("select * from graph_edges where repo_id = ? order by kind asc, id asc")
      .all(repoId) as GraphEdgeRow[];
    return rows.map((row) => graphEdgeSchema.parse(graphEdgeFromRow(row)));
  }

  upsertFingerprint(fingerprint: Fingerprint): void {
    const parsed = fingerprintSchema.parse(fingerprint);
    this.db
      .prepare(
        `
        insert into fingerprints (
          id, repo_id, worktree_id, diff_hash, created_at,
          files_touched_json, symbols_json, surfaces_json, semantic_summary,
          contract_changes_json, confidence, source
        )
        values (
          @id, @repoId, @worktreeId, @diffHash, @createdAt,
          @filesTouchedJson, @symbolsJson, @surfacesJson, @semanticSummary,
          @contractChangesJson, @confidence, @source
        )
        on conflict(worktree_id, diff_hash) do nothing
      `
      )
      .run({
        ...parsed,
        filesTouchedJson: JSON.stringify(parsed.filesTouched),
        symbolsJson: JSON.stringify(parsed.symbols),
        surfacesJson: JSON.stringify(parsed.surfaces),
        contractChangesJson: JSON.stringify(parsed.contractChanges)
      });
  }

  listFingerprints(repoId: string): Fingerprint[] {
    const rows = this.db
      .prepare("select * from fingerprints where repo_id = ? order by created_at desc")
      .all(repoId) as FingerprintRow[];
    return rows.map((row) => fingerprintSchema.parse(fingerprintFromRow(row)));
  }

  upsertAgentSession(session: AgentSession): void {
    const parsed = agentSessionSchema.parse(session);
    this.db
      .prepare(
        `
        insert into agent_sessions (
          id, repo_id, worktree_id, agent_kind, coordination_role, cwd, display_name,
          current_plan, last_checkpoint_at, joined_at
        )
        values (
          @id, @repoId, @worktreeId, @agentKind, @coordinationRole, @cwd, @displayName,
          @currentPlan, @lastCheckpointAt, @joinedAt
        )
        on conflict(id) do update set
          worktree_id = excluded.worktree_id,
          agent_kind = excluded.agent_kind,
          coordination_role = excluded.coordination_role,
          cwd = excluded.cwd,
          display_name = excluded.display_name,
          last_checkpoint_at = excluded.last_checkpoint_at
      `
      )
      .run({
        ...parsed,
        coordinationRole: parsed.coordinationRole ?? "feature",
        currentPlan: parsed.currentPlan ?? null
      });
  }

  listAgentSessions(repoId: string): AgentSession[] {
    const rows = this.db
      .prepare("select * from agent_sessions where repo_id = ? order by joined_at desc")
      .all(repoId) as AgentSessionRow[];
    return rows.map((row) => agentSessionSchema.parse(agentSessionFromRow(row)));
  }

  updateAgentPlan(sessionId: string, plan: string, updatedAt: number): void {
    this.db
      .prepare(
        "update agent_sessions set current_plan = ?, last_checkpoint_at = ? where id = ?"
      )
      .run(plan, updatedAt, sessionId);
  }

  updateAgentCheckpoint(sessionId: string, updatedAt: number): void {
    this.db
      .prepare("update agent_sessions set last_checkpoint_at = ? where id = ?")
      .run(updatedAt, sessionId);
  }

  upsertConflict(conflict: RebaseConflict): void {
    const parsed = conflictSchema.parse(conflict);
    this.db
      .prepare(
        `
        insert into conflicts (
          id, repo_id, status, risk, confidence, type, title, summary,
          primary_surface, affected_worktree_ids_json, affected_surfaces_json,
          evidence_json, risk_reasons_json, classification_json,
          token_cost_estimate_json, debate_json,
          created_at, updated_at
        )
        values (
          @id, @repoId, @status, @risk, @confidence, @type, @title, @summary,
          @primarySurface, @affectedWorktreeIdsJson, @affectedSurfacesJson,
          @evidenceJson, @riskReasonsJson, @classificationJson,
          @tokenCostEstimateJson, @debateJson,
          @createdAt, @updatedAt
        )
        on conflict(id) do update set
          status = excluded.status,
          risk = excluded.risk,
          confidence = excluded.confidence,
          type = excluded.type,
          title = excluded.title,
          summary = excluded.summary,
          primary_surface = excluded.primary_surface,
          affected_worktree_ids_json = excluded.affected_worktree_ids_json,
          affected_surfaces_json = excluded.affected_surfaces_json,
          evidence_json = excluded.evidence_json,
          risk_reasons_json = excluded.risk_reasons_json,
          classification_json = excluded.classification_json,
          token_cost_estimate_json = excluded.token_cost_estimate_json,
          debate_json = excluded.debate_json,
          updated_at = excluded.updated_at
      `
      )
      .run({
        ...parsed,
        affectedWorktreeIdsJson: JSON.stringify(parsed.affectedWorktreeIds),
        affectedSurfacesJson: JSON.stringify(parsed.affectedSurfaces),
        evidenceJson: JSON.stringify(parsed.evidence),
        riskReasonsJson: JSON.stringify(parsed.riskReasons),
        classificationJson: parsed.classification
          ? JSON.stringify(parsed.classification)
          : null,
        tokenCostEstimateJson: parsed.tokenCostEstimate
          ? JSON.stringify(parsed.tokenCostEstimate)
          : null,
        debateJson: parsed.debate ? JSON.stringify(parsed.debate) : null
      });
  }

  listConflicts(repoId: string): RebaseConflict[] {
    const rows = this.db
      .prepare("select * from conflicts where repo_id = ? order by updated_at desc")
      .all(repoId) as ConflictRow[];
    return rows.map((row) => conflictSchema.parse(conflictFromRow(row)));
  }

  updateConflictStatus(
    id: string,
    status: ConflictStatus,
    updatedAt: number
  ): void {
    this.db
      .prepare("update conflicts set status = ?, updated_at = ? where id = ?")
      .run(status, updatedAt, id);
  }

  upsertCoordinationEpisode(episode: CoordinationEpisode): void {
    const parsed = coordinationEpisodeSchema.parse(episode);
    this.db
      .prepare(
        `
        insert into coordination_episodes (
          id, repo_id, surface, status, risk, confidence,
          affected_worktree_ids_json, affected_agent_session_ids_json,
          conflict_ids_json, owner_agent_session_id, merge_contract_json,
          rocket_ride_run_ids_json, created_at, updated_at
        )
        values (
          @id, @repoId, @surface, @status, @risk, @confidence,
          @affectedWorktreeIdsJson, @affectedAgentSessionIdsJson,
          @conflictIdsJson, @ownerAgentSessionId, @mergeContractJson,
          @rocketRideRunIdsJson, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          surface = excluded.surface,
          status = excluded.status,
          risk = excluded.risk,
          confidence = excluded.confidence,
          affected_worktree_ids_json = excluded.affected_worktree_ids_json,
          affected_agent_session_ids_json = excluded.affected_agent_session_ids_json,
          conflict_ids_json = excluded.conflict_ids_json,
          owner_agent_session_id = excluded.owner_agent_session_id,
          merge_contract_json = excluded.merge_contract_json,
          rocket_ride_run_ids_json = excluded.rocket_ride_run_ids_json,
          updated_at = excluded.updated_at
      `
      )
      .run({
        ...parsed,
        affectedWorktreeIdsJson: JSON.stringify(parsed.affectedWorktreeIds),
        affectedAgentSessionIdsJson: JSON.stringify(parsed.affectedAgentSessionIds),
        conflictIdsJson: JSON.stringify(parsed.conflictIds),
        ownerAgentSessionId: parsed.ownerAgentSessionId ?? null,
        mergeContractJson: parsed.mergeContract
          ? JSON.stringify(parsed.mergeContract)
          : null,
        rocketRideRunIdsJson: JSON.stringify(parsed.rocketRideRunIds)
      });
  }

  listCoordinationEpisodes(repoId: string): CoordinationEpisode[] {
    const rows = this.db
      .prepare(
        "select * from coordination_episodes where repo_id = ? order by updated_at desc"
      )
      .all(repoId) as CoordinationEpisodeRow[];
    return rows.map((row) =>
      coordinationEpisodeSchema.parse(coordinationEpisodeFromRow(row))
    );
  }

  upsertMergeRiskAssessment(assessment: MergeRiskAssessment): void {
    const parsed = mergeRiskAssessmentSchema.parse(assessment);
    this.db
      .prepare(
        `
        insert into merge_risk_assessments (
          id, repo_id, episode_id, status, risk, safe, diff_hash,
          rocket_ride_run_id, predicted_conflicts_json, warnings_json,
          required_work_orders_json, evidence_json, created_at
        )
        values (
          @id, @repoId, @episodeId, @status, @risk, @safe, @diffHash,
          @rocketRideRunId, @predictedConflictsJson, @warningsJson,
          @requiredWorkOrdersJson, @evidenceJson, @createdAt
        )
        on conflict(id) do update set
          status = excluded.status,
          risk = excluded.risk,
          safe = excluded.safe,
          rocket_ride_run_id = excluded.rocket_ride_run_id,
          predicted_conflicts_json = excluded.predicted_conflicts_json,
          warnings_json = excluded.warnings_json,
          required_work_orders_json = excluded.required_work_orders_json,
          evidence_json = excluded.evidence_json
      `
      )
      .run({
        ...parsed,
        safe: parsed.safe ? 1 : 0,
        rocketRideRunId: parsed.rocketRideRunId ?? null,
        predictedConflictsJson: JSON.stringify(parsed.predictedConflicts),
        warningsJson: JSON.stringify(parsed.warnings),
        requiredWorkOrdersJson: JSON.stringify(parsed.requiredWorkOrders),
        evidenceJson: JSON.stringify(parsed.evidence)
      });
  }

  listMergeRiskAssessments(repoId: string): MergeRiskAssessment[] {
    const rows = this.db
      .prepare(
        "select * from merge_risk_assessments where repo_id = ? order by created_at desc"
      )
      .all(repoId) as MergeRiskAssessmentRow[];
    return rows.map((row) =>
      mergeRiskAssessmentSchema.parse(mergeRiskAssessmentFromRow(row))
    );
  }

  listLatestMergeRiskAssessments(repoId: string): MergeRiskAssessment[] {
    const rows = this.db
      .prepare(
        `
        select mra.*
        from merge_risk_assessments mra
        join (
          select episode_id, max(created_at) as created_at
          from merge_risk_assessments
          where repo_id = ?
          group by episode_id
        ) latest
          on latest.episode_id = mra.episode_id
         and latest.created_at = mra.created_at
        where mra.repo_id = ?
        order by mra.created_at desc
      `
      )
      .all(repoId, repoId) as MergeRiskAssessmentRow[];
    return rows.map((row) =>
      mergeRiskAssessmentSchema.parse(mergeRiskAssessmentFromRow(row))
    );
  }

  upsertWorkOrder(workOrder: WorkOrder): void {
    const parsed = workOrderSchema.parse(workOrder);
    this.db
      .prepare(
        `
        insert into work_orders (
          id, repo_id, episode_id, agent_session_id, role, status, revision,
          title, summary, required_contract, allowed_files_json,
          blocked_files_json, shared_files_json, next_checkpoint,
          created_at, updated_at, delivered_at, acknowledged_at
        )
        values (
          @id, @repoId, @episodeId, @agentSessionId, @role, @status, @revision,
          @title, @summary, @requiredContract, @allowedFilesJson,
          @blockedFilesJson, @sharedFilesJson, @nextCheckpoint,
          @createdAt, @updatedAt, @deliveredAt, @acknowledgedAt
        )
        on conflict(id) do update set
          status = case
            when work_orders.status in ('fetched', 'acknowledged', 'completed')
            then work_orders.status
            else excluded.status
          end,
          role = excluded.role,
          title = excluded.title,
          summary = excluded.summary,
          required_contract = excluded.required_contract,
          allowed_files_json = excluded.allowed_files_json,
          blocked_files_json = excluded.blocked_files_json,
          shared_files_json = excluded.shared_files_json,
          next_checkpoint = excluded.next_checkpoint,
          updated_at = excluded.updated_at
      `
      )
      .run({
        ...parsed,
        requiredContract: parsed.requiredContract ?? null,
        allowedFilesJson: JSON.stringify(parsed.allowedFiles),
        blockedFilesJson: JSON.stringify(parsed.blockedFiles),
        sharedFilesJson: JSON.stringify(parsed.sharedFiles),
        deliveredAt: parsed.deliveredAt ?? null,
        acknowledgedAt: parsed.acknowledgedAt ?? null
      });
    this.db
      .prepare(
        `
        update work_orders
        set status = 'superseded', updated_at = ?
        where repo_id = ?
          and episode_id = ?
          and agent_session_id = ?
          and revision < ?
          and status in ('queued', 'active', 'fetched', 'acknowledged')
      `
      )
      .run(
        parsed.updatedAt,
        parsed.repoId,
        parsed.episodeId,
        parsed.agentSessionId,
        parsed.revision
      );
  }

  listWorkOrders(repoId: string): WorkOrder[] {
    const rows = this.db
      .prepare("select * from work_orders where repo_id = ? order by updated_at desc")
      .all(repoId) as WorkOrderRow[];
    return rows.map((row) => workOrderSchema.parse(workOrderFromRow(row)));
  }

  listQueuedWorkOrders(repoId: string, agentSessionId: string): WorkOrder[] {
    const rows = this.db
      .prepare(
        "select * from work_orders where repo_id = ? and agent_session_id = ? and status = 'queued' order by created_at asc"
      )
      .all(repoId, agentSessionId) as WorkOrderRow[];
    return rows.map((row) => workOrderSchema.parse(workOrderFromRow(row)));
  }

  listActiveWorkOrders(repoId: string, agentSessionId: string): WorkOrder[] {
    const rows = this.db
      .prepare(
        "select * from work_orders where repo_id = ? and agent_session_id = ? and status in ('fetched', 'acknowledged') order by updated_at desc"
      )
      .all(repoId, agentSessionId) as WorkOrderRow[];
    return rows.map((row) => workOrderSchema.parse(workOrderFromRow(row)));
  }

  markWorkOrderFetched(id: string, fetchedAt: number): void {
    this.db
      .prepare("update work_orders set status = 'fetched', delivered_at = ? where id = ?")
      .run(fetchedAt, id);
  }

  markWorkOrderAcknowledged(id: string, acknowledgedAt: number): void {
    this.db
      .prepare(
        "update work_orders set status = 'acknowledged', acknowledged_at = ? where id = ?"
      )
      .run(acknowledgedAt, id);
  }

  markWorkOrderCompleted(id: string, completedAt: number): void {
    this.db
      .prepare("update work_orders set status = 'completed', updated_at = ? where id = ?")
      .run(completedAt, id);
  }

  upsertConflictDecision(decision: ConflictDecision): void {
    const parsed = conflictDecisionSchema.parse(decision);
    this.db
      .prepare(
        `
        insert into conflict_decisions (
          id, repo_id, conflict_id, selected_option_id, selected_option_title,
          selected_option_direction, owner_agent_session_id, created_by, status,
          created_at, updated_at
        )
        values (
          @id, @repoId, @conflictId, @selectedOptionId, @selectedOptionTitle,
          @selectedOptionDirection, @ownerAgentSessionId, @createdBy, @status,
          @createdAt, @updatedAt
        )
        on conflict(id) do update set
          selected_option_id = excluded.selected_option_id,
          selected_option_title = excluded.selected_option_title,
          selected_option_direction = excluded.selected_option_direction,
          owner_agent_session_id = excluded.owner_agent_session_id,
          status = excluded.status,
          updated_at = excluded.updated_at
      `
      )
      .run({
        ...parsed,
        ownerAgentSessionId: parsed.ownerAgentSessionId ?? null
      });
    this.upsertGraphNode({
      id: `decision:${parsed.id}`,
      repoId: parsed.repoId,
      kind: "decision",
      label: parsed.selectedOptionTitle,
      refId: parsed.id,
      metadata: {
        conflictId: parsed.conflictId,
        direction: parsed.selectedOptionDirection,
        createdBy: parsed.createdBy,
        status: parsed.status
      },
      updatedAt: parsed.updatedAt
    });
    this.upsertGraphEdge({
      id: `decision:${parsed.id}->conflict:${parsed.conflictId}`,
      repoId: parsed.repoId,
      sourceId: `decision:${parsed.id}`,
      targetId: `conflict:${parsed.conflictId}`,
      kind: "decides",
      metadata: {
        selectedOptionId: parsed.selectedOptionId
      },
      updatedAt: parsed.updatedAt
    });
  }

  getActiveConflictDecision(conflictId: string): ConflictDecision | null {
    const row = this.db
      .prepare(
        "select * from conflict_decisions where conflict_id = ? and status = 'active' order by created_at asc limit 1"
      )
      .get(conflictId) as ConflictDecisionRow | undefined;
    return row ? conflictDecisionSchema.parse(conflictDecisionFromRow(row)) : null;
  }

  listConflictDecisions(repoId: string): ConflictDecision[] {
    const rows = this.db
      .prepare("select * from conflict_decisions where repo_id = ? order by created_at desc")
      .all(repoId) as ConflictDecisionRow[];
    return rows.map((row) =>
      conflictDecisionSchema.parse(conflictDecisionFromRow(row))
    );
  }

  upsertAdvisory(advisory: Advisory): void {
    const parsed = advisorySchema.parse(advisory);
    this.db
      .prepare(
        `
        insert into advisories (id, repo_id, conflict_id, options_json, source, created_at)
        values (@id, @repoId, @conflictId, @optionsJson, @source, @createdAt)
        on conflict(id) do update set
          options_json = excluded.options_json,
          source = excluded.source
      `
      )
      .run({
        ...parsed,
        optionsJson: JSON.stringify(parsed.options)
      });
  }

  listAdvisories(repoId: string): Advisory[] {
    const rows = this.db
      .prepare("select * from advisories where repo_id = ? order by created_at desc")
      .all(repoId) as AdvisoryRow[];
    return rows.map((row) => advisorySchema.parse(advisoryFromRow(row)));
  }

  upsertContractPublication(publication: ContractPublication): void {
    const parsed = contractPublicationSchema.parse(publication);
    this.db
      .prepare(
        `
        insert into contract_publications (
          id, repo_id, conflict_id, owner_agent_session_id, surface,
          shape_summary, files_json, created_at
        )
        values (
          @id, @repoId, @conflictId, @ownerAgentSessionId, @surface,
          @shapeSummary, @filesJson, @createdAt
        )
        on conflict(id) do update set
          surface = excluded.surface,
          shape_summary = excluded.shape_summary,
          files_json = excluded.files_json
      `
      )
      .run({
        ...parsed,
        filesJson: JSON.stringify(parsed.files)
      });
  }

  listContractPublications(repoId: string): ContractPublication[] {
    const rows = this.db
      .prepare(
        "select * from contract_publications where repo_id = ? order by created_at desc"
      )
      .all(repoId) as ContractPublicationRow[];
    return rows.map((row) =>
      contractPublicationSchema.parse(contractPublicationFromRow(row))
    );
  }

  upsertIntervention(intervention: Intervention): void {
    const parsed = interventionSchema.parse(intervention);
    this.db
      .prepare(
        `
        insert into interventions (
          id, repo_id, conflict_id, target_agent_session_ids_json, draft,
          edited_direction, directive_json, status, created_at, sent_at, fetched_at,
          acknowledged_at
        )
        values (
          @id, @repoId, @conflictId, @targetAgentSessionIdsJson, @draft,
          @editedDirection, @directiveJson, @status, @createdAt, @sentAt,
          @fetchedAt, @acknowledgedAt
        )
        on conflict(id) do update set
          target_agent_session_ids_json = excluded.target_agent_session_ids_json,
          draft = excluded.draft,
          edited_direction = excluded.edited_direction,
          directive_json = excluded.directive_json,
          status = excluded.status,
          sent_at = excluded.sent_at,
          fetched_at = excluded.fetched_at,
          acknowledged_at = excluded.acknowledged_at
      `
      )
      .run({
        ...parsed,
        targetAgentSessionIdsJson: JSON.stringify(parsed.targetAgentSessionIds),
        directiveJson: parsed.directive ? JSON.stringify(parsed.directive) : null,
        sentAt: parsed.sentAt ?? null,
        fetchedAt: parsed.fetchedAt ?? null,
        acknowledgedAt: parsed.acknowledgedAt ?? null
      });
  }

  listInterventions(repoId: string): Intervention[] {
    const rows = this.db
      .prepare("select * from interventions where repo_id = ? order by created_at desc")
      .all(repoId) as InterventionRow[];
    return rows.map((row) => interventionSchema.parse(interventionFromRow(row)));
  }

  listQueuedInterventions(repoId: string, agentSessionId: string): Intervention[] {
    const rows = this.db
      .prepare(
        "select * from interventions where repo_id = ? and status = 'queued' order by created_at asc"
      )
      .all(repoId) as InterventionRow[];
    return rows
      .map((row) => interventionSchema.parse(interventionFromRow(row)))
      .filter((intervention) =>
        intervention.targetAgentSessionIds.includes(agentSessionId)
      );
  }

  markInterventionFetched(id: string, fetchedAt: number): void {
    this.db
      .prepare("update interventions set status = 'fetched', fetched_at = ? where id = ?")
      .run(fetchedAt, id);
  }

  markInterventionAcknowledged(id: string, acknowledgedAt: number): void {
    this.db
      .prepare(
        "update interventions set status = 'acknowledged', acknowledged_at = ? where id = ?"
      )
      .run(acknowledgedAt, id);
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists repos (
      id text primary key,
      root_path text not null,
      name text not null,
      created_at integer not null,
      updated_at integer not null
    );

    create table if not exists worktrees (
      id text primary key,
      repo_id text not null,
      path text not null,
      branch text,
      head_sha text,
      dirty integer not null default 0,
      status text not null,
      last_observed_at integer not null,
      unique(repo_id, path)
    );

    create table if not exists agent_sessions (
      id text primary key,
      repo_id text not null,
      worktree_id text,
      agent_kind text not null,
      coordination_role text not null default 'feature',
      cwd text not null,
      display_name text not null,
      current_plan text,
      last_checkpoint_at integer,
      joined_at integer not null
    );

    create table if not exists fingerprints (
      id text primary key,
      repo_id text not null,
      worktree_id text not null,
      diff_hash text not null,
      created_at integer not null,
      files_touched_json text not null,
      symbols_json text not null,
      surfaces_json text not null,
      semantic_summary text not null,
      contract_changes_json text not null,
      confidence real not null,
      source text not null,
      unique(worktree_id, diff_hash)
    );

    create table if not exists conflicts (
      id text primary key,
      repo_id text not null,
      status text not null,
      risk text not null,
      confidence real not null,
      type text not null,
      title text not null,
      summary text not null,
      primary_surface text not null default 'shared surface',
      affected_worktree_ids_json text not null,
      affected_surfaces_json text not null,
      evidence_json text not null,
      risk_reasons_json text not null default '[]',
      classification_json text,
      token_cost_estimate_json text,
      debate_json text,
      created_at integer not null,
      updated_at integer not null
    );

    create table if not exists coordination_episodes (
      id text primary key,
      repo_id text not null,
      surface text not null,
      status text not null,
      risk text not null,
      confidence real not null,
      affected_worktree_ids_json text not null,
      affected_agent_session_ids_json text not null,
      conflict_ids_json text not null,
      owner_agent_session_id text,
      merge_contract_json text,
      rocket_ride_run_ids_json text not null,
      created_at integer not null,
      updated_at integer not null
    );

    create table if not exists work_orders (
      id text primary key,
      repo_id text not null,
      episode_id text not null,
      agent_session_id text not null,
      role text not null,
      status text not null,
      revision integer not null,
      title text not null,
      summary text not null,
      required_contract text,
      allowed_files_json text not null,
      blocked_files_json text not null,
      shared_files_json text not null,
      next_checkpoint text not null,
      created_at integer not null,
      updated_at integer not null,
      delivered_at integer,
      acknowledged_at integer
    );

    create table if not exists merge_risk_assessments (
      id text primary key,
      repo_id text not null,
      episode_id text not null,
      status text not null,
      risk text not null,
      safe integer not null,
      diff_hash text not null,
      rocket_ride_run_id text,
      predicted_conflicts_json text not null,
      warnings_json text not null,
      required_work_orders_json text not null,
      evidence_json text not null,
      created_at integer not null
    );

    create table if not exists advisories (
      id text primary key,
      repo_id text not null,
      conflict_id text not null,
      options_json text not null,
      source text not null,
      created_at integer not null
    );

    create table if not exists conflict_decisions (
      id text primary key,
      repo_id text not null,
      conflict_id text not null,
      selected_option_id text not null,
      selected_option_title text not null,
      selected_option_direction text not null,
      owner_agent_session_id text,
      created_by text not null,
      status text not null,
      created_at integer not null,
      updated_at integer not null
    );

    create table if not exists contract_publications (
      id text primary key,
      repo_id text not null,
      conflict_id text not null,
      owner_agent_session_id text not null,
      surface text not null,
      shape_summary text not null,
      files_json text not null,
      created_at integer not null
    );

    create table if not exists interventions (
      id text primary key,
      repo_id text not null,
      conflict_id text not null,
      target_agent_session_ids_json text not null,
      draft text not null,
      edited_direction text not null,
      directive_json text,
      status text not null,
      created_at integer not null,
      sent_at integer,
      fetched_at integer,
      acknowledged_at integer
    );

    create table if not exists events (
      id text primary key,
      repo_id text not null,
      type text not null,
      message text not null,
      payload_json text not null,
      created_at integer not null
    );

    create table if not exists hook_events (
      id text primary key,
      repo_id text not null,
      session_id text not null,
      worktree_id text,
      agent_kind text not null,
      cwd text not null,
      kind text not null,
      received_at integer not null,
      prompt text,
      tool_name text,
      command text,
      outcome text,
      file_paths_json text not null,
      metadata_json text not null
    );

    create table if not exists evidence_packets (
      id text primary key,
      repo_id text not null,
      session_id text not null,
      worktree_id text,
      created_at integer not null,
      updated_at integer not null,
      expires_at integer not null,
      source text not null,
      prompt_summary text,
      plan_summary text,
      hook_events_json text not null,
      git_json text not null,
      surfaces_json text not null,
      decision_history_json text not null,
      privacy_json text not null
    );

    create table if not exists cloud_escalation_packets (
      id text primary key,
      repo_id text not null,
      conflict_id text,
      evidence_packet_ids_json text not null,
      provider text not null,
      reason text not null,
      status text not null,
      redactions_json text not null,
      redacted_context_json text not null,
      created_at integer not null,
      sent_at integer
    );

    create table if not exists graph_nodes (
      id text primary key,
      repo_id text not null,
      kind text not null,
      label text not null,
      ref_id text,
      metadata_json text not null,
      updated_at integer not null
    );

    create table if not exists graph_edges (
      id text primary key,
      repo_id text not null,
      source_id text not null,
      target_id text not null,
      kind text not null,
      metadata_json text not null,
      updated_at integer not null
    );

    create table if not exists eval_runs (
      id text primary key,
      repo_id text not null,
      status text not null,
      metrics_json text not null,
      created_at integer not null,
      completed_at integer
    );

    create table if not exists eval_cases (
      id text primary key,
      run_id text not null,
      language text not null,
      expected_risk text not null,
      actual_risk text,
      verdict text,
      latency_ms integer,
      evidence_json text not null
    );

    create table if not exists settings (
      key text primary key,
      value_json text not null,
      updated_at integer not null
    );
  `);
  addColumnIfMissing(
    db,
    "conflicts",
    "primary_surface",
    "primary_surface text not null default 'shared surface'"
  );
  addColumnIfMissing(
    db,
    "conflicts",
    "risk_reasons_json",
    "risk_reasons_json text not null default '[]'"
  );
  addColumnIfMissing(
    db,
    "interventions",
    "directive_json",
    "directive_json text"
  );
  addColumnIfMissing(
    db,
    "conflicts",
    "classification_json",
    "classification_json text"
  );
  addColumnIfMissing(
    db,
    "conflicts",
    "token_cost_estimate_json",
    "token_cost_estimate_json text"
  );
  addColumnIfMissing(db, "conflicts", "debate_json", "debate_json text");
  addColumnIfMissing(
    db,
    "agent_sessions",
    "coordination_role",
    "coordination_role text not null default 'feature'"
  );
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`alter table ${table} add column ${definition};`);
  }
}

interface RepoRow {
  id: string;
  root_path: string;
  name: string;
  created_at: number;
  updated_at: number;
}

function repoFromRow(row: RepoRow): RebaseRepo {
  return {
    id: row.id,
    rootPath: row.root_path,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface EventRow {
  id: string;
  repo_id: string;
  type: string;
  message: string;
  payload_json: string;
  created_at: number;
}

interface HookEventRow {
  id: string;
  repo_id: string;
  session_id: string;
  worktree_id: string | null;
  agent_kind: HookEvent["agentKind"];
  cwd: string;
  kind: HookEvent["kind"];
  received_at: number;
  prompt: string | null;
  tool_name: string | null;
  command: string | null;
  outcome: string | null;
  file_paths_json: string;
  metadata_json: string;
}

interface EvidencePacketRow {
  id: string;
  repo_id: string;
  session_id: string;
  worktree_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  source: EvidencePacket["source"];
  prompt_summary: string | null;
  plan_summary: string | null;
  hook_events_json: string;
  git_json: string;
  surfaces_json: string;
  decision_history_json: string;
  privacy_json: string;
}

interface CloudEscalationPacketRow {
  id: string;
  repo_id: string;
  conflict_id: string | null;
  evidence_packet_ids_json: string;
  provider: string;
  reason: string;
  status: CloudEscalationPacket["status"];
  redactions_json: string;
  redacted_context_json: string;
  created_at: number;
  sent_at: number | null;
}

interface GraphNodeRow {
  id: string;
  repo_id: string;
  kind: RebaseGraphNode["kind"];
  label: string;
  ref_id: string | null;
  metadata_json: string;
  updated_at: number;
}

interface GraphEdgeRow {
  id: string;
  repo_id: string;
  source_id: string;
  target_id: string;
  kind: RebaseGraphEdge["kind"];
  metadata_json: string;
  updated_at: number;
}

interface WorktreeRow {
  id: string;
  repo_id: string;
  path: string;
  branch: string | null;
  head_sha: string | null;
  dirty: number;
  status: RebaseWorktree["status"];
  last_observed_at: number;
}

function worktreeFromRow(row: WorktreeRow): RebaseWorktree {
  return {
    id: row.id,
    repoId: row.repo_id,
    path: row.path,
    branch: row.branch,
    headSha: row.head_sha,
    dirty: Boolean(row.dirty),
    status: row.status,
    lastObservedAt: row.last_observed_at
  };
}

function eventFromRow(row: EventRow): RebaseEvent {
  return {
    id: row.id,
    repoId: row.repo_id,
    type: row.type,
    message: row.message,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function hookEventFromRow(row: HookEventRow): HookEvent {
  return {
    id: row.id,
    repoId: row.repo_id,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    agentKind: row.agent_kind,
    cwd: row.cwd,
    kind: row.kind,
    receivedAt: row.received_at,
    ...(row.prompt ? { prompt: row.prompt } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    filePaths: JSON.parse(row.file_paths_json) as string[],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}

function evidencePacketFromRow(row: EvidencePacketRow): EvidencePacket {
  return {
    id: row.id,
    repoId: row.repo_id,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    source: row.source,
    ...(row.prompt_summary ? { promptSummary: row.prompt_summary } : {}),
    ...(row.plan_summary ? { planSummary: row.plan_summary } : {}),
    hookEvents: JSON.parse(row.hook_events_json) as HookEvent[],
    git: JSON.parse(row.git_json) as EvidencePacket["git"],
    surfaces: JSON.parse(row.surfaces_json) as EvidencePacket["surfaces"],
    decisionHistory: JSON.parse(
      row.decision_history_json
    ) as EvidencePacket["decisionHistory"],
    privacy: JSON.parse(row.privacy_json) as EvidencePacket["privacy"]
  };
}

function cloudEscalationPacketFromRow(
  row: CloudEscalationPacketRow
): CloudEscalationPacket {
  return {
    id: row.id,
    repoId: row.repo_id,
    ...(row.conflict_id ? { conflictId: row.conflict_id } : {}),
    evidencePacketIds: JSON.parse(row.evidence_packet_ids_json) as string[],
    provider: row.provider,
    reason: row.reason,
    status: row.status,
    redactions: JSON.parse(row.redactions_json) as string[],
    redactedContext: JSON.parse(row.redacted_context_json) as Record<
      string,
      unknown
    >,
    createdAt: row.created_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {})
  };
}

function graphNodeFromRow(row: GraphNodeRow): RebaseGraphNode {
  return {
    id: row.id,
    repoId: row.repo_id,
    kind: row.kind,
    label: row.label,
    ...(row.ref_id ? { refId: row.ref_id } : {}),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    updatedAt: row.updated_at
  };
}

function graphEdgeFromRow(row: GraphEdgeRow): RebaseGraphEdge {
  return {
    id: row.id,
    repoId: row.repo_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    kind: row.kind,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    updatedAt: row.updated_at
  };
}

interface ConflictRow {
  id: string;
  repo_id: string;
  status: ConflictStatus;
  risk: RebaseConflict["risk"];
  confidence: number;
  type: RebaseConflict["type"];
  title: string;
  summary: string;
  primary_surface: string;
  affected_worktree_ids_json: string;
  affected_surfaces_json: string;
  evidence_json: string;
  risk_reasons_json: string;
  classification_json: string | null;
  token_cost_estimate_json: string | null;
  debate_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CoordinationEpisodeRow {
  id: string;
  repo_id: string;
  surface: string;
  status: CoordinationEpisode["status"];
  risk: CoordinationEpisode["risk"];
  confidence: number;
  affected_worktree_ids_json: string;
  affected_agent_session_ids_json: string;
  conflict_ids_json: string;
  owner_agent_session_id: string | null;
  merge_contract_json: string | null;
  rocket_ride_run_ids_json: string;
  created_at: number;
  updated_at: number;
}

interface WorkOrderRow {
  id: string;
  repo_id: string;
  episode_id: string;
  agent_session_id: string;
  role: WorkOrder["role"];
  status: WorkOrder["status"];
  revision: number;
  title: string;
  summary: string;
  required_contract: string | null;
  allowed_files_json: string;
  blocked_files_json: string;
  shared_files_json: string;
  next_checkpoint: string;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
}

interface MergeRiskAssessmentRow {
  id: string;
  repo_id: string;
  episode_id: string;
  status: MergeRiskAssessment["status"];
  risk: MergeRiskAssessment["risk"];
  safe: number;
  diff_hash: string;
  rocket_ride_run_id: string | null;
  predicted_conflicts_json: string;
  warnings_json: string;
  required_work_orders_json: string;
  evidence_json: string;
  created_at: number;
}

function conflictFromRow(row: ConflictRow): RebaseConflict {
  return {
    id: row.id,
    repoId: row.repo_id,
    status: row.status,
    risk: row.risk,
    confidence: row.confidence,
    type: row.type,
    title: row.title,
    summary: row.summary,
    primarySurface: row.primary_surface,
    affectedWorktreeIds: JSON.parse(row.affected_worktree_ids_json) as string[],
    affectedSurfaces: JSON.parse(row.affected_surfaces_json) as string[],
    evidence: JSON.parse(row.evidence_json) as string[],
    riskReasons: JSON.parse(row.risk_reasons_json) as RebaseConflict["riskReasons"],
    ...(row.classification_json
      ? {
          classification: JSON.parse(
            row.classification_json
          ) as RebaseConflict["classification"]
        }
      : {}),
    ...(row.token_cost_estimate_json
      ? {
          tokenCostEstimate: JSON.parse(
            row.token_cost_estimate_json
          ) as RebaseConflict["tokenCostEstimate"]
        }
      : {}),
    ...(row.debate_json
      ? { debate: JSON.parse(row.debate_json) as RebaseConflict["debate"] }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function coordinationEpisodeFromRow(
  row: CoordinationEpisodeRow
): CoordinationEpisode {
  return {
    id: row.id,
    repoId: row.repo_id,
    surface: row.surface,
    status: row.status,
    risk: row.risk,
    confidence: row.confidence,
    affectedWorktreeIds: JSON.parse(row.affected_worktree_ids_json) as string[],
    affectedAgentSessionIds: JSON.parse(
      row.affected_agent_session_ids_json
    ) as string[],
    conflictIds: JSON.parse(row.conflict_ids_json) as string[],
    ...(row.owner_agent_session_id
      ? { ownerAgentSessionId: row.owner_agent_session_id }
      : {}),
    ...(row.merge_contract_json
      ? {
          mergeContract: JSON.parse(
            row.merge_contract_json
          ) as CoordinationEpisode["mergeContract"]
        }
      : {}),
    rocketRideRunIds: JSON.parse(row.rocket_ride_run_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function workOrderFromRow(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    repoId: row.repo_id,
    episodeId: row.episode_id,
    agentSessionId: row.agent_session_id,
    role: row.role,
    status: row.status,
    revision: row.revision,
    title: row.title,
    summary: row.summary,
    ...(row.required_contract ? { requiredContract: row.required_contract } : {}),
    allowedFiles: JSON.parse(row.allowed_files_json) as string[],
    blockedFiles: JSON.parse(row.blocked_files_json) as string[],
    sharedFiles: JSON.parse(row.shared_files_json) as string[],
    nextCheckpoint: row.next_checkpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {})
  };
}

function mergeRiskAssessmentFromRow(
  row: MergeRiskAssessmentRow
): MergeRiskAssessment {
  return {
    id: row.id,
    repoId: row.repo_id,
    episodeId: row.episode_id,
    status: row.status,
    risk: row.risk,
    safe: Boolean(row.safe),
    diffHash: row.diff_hash,
    ...(row.rocket_ride_run_id
      ? { rocketRideRunId: row.rocket_ride_run_id }
      : {}),
    predictedConflicts: JSON.parse(
      row.predicted_conflicts_json
    ) as MergeRiskAssessment["predictedConflicts"],
    warnings: JSON.parse(row.warnings_json) as string[],
    requiredWorkOrders: JSON.parse(row.required_work_orders_json) as string[],
    evidence: JSON.parse(row.evidence_json) as MergeRiskAssessment["evidence"],
    createdAt: row.created_at
  };
}

interface FingerprintRow {
  id: string;
  repo_id: string;
  worktree_id: string;
  diff_hash: string;
  created_at: number;
  files_touched_json: string;
  symbols_json: string;
  surfaces_json: string;
  semantic_summary: string;
  contract_changes_json: string;
  confidence: number;
  source: Fingerprint["source"];
}

function fingerprintFromRow(row: FingerprintRow): Fingerprint {
  return {
    id: row.id,
    repoId: row.repo_id,
    worktreeId: row.worktree_id,
    diffHash: row.diff_hash,
    createdAt: row.created_at,
    filesTouched: JSON.parse(row.files_touched_json) as string[],
    symbols: JSON.parse(row.symbols_json) as Fingerprint["symbols"],
    surfaces: JSON.parse(row.surfaces_json) as Fingerprint["surfaces"],
    semanticSummary: row.semantic_summary,
    contractChanges: JSON.parse(row.contract_changes_json) as string[],
    confidence: row.confidence,
    source: row.source
  };
}

interface AgentSessionRow {
  id: string;
  repo_id: string;
  worktree_id: string | null;
  agent_kind: AgentSession["agentKind"];
  coordination_role: NonNullable<AgentSession["coordinationRole"]>;
  cwd: string;
  display_name: string;
  current_plan: string | null;
  last_checkpoint_at: number | null;
  joined_at: number;
}

function agentSessionFromRow(row: AgentSessionRow): AgentSession {
  const base = {
    id: row.id,
    repoId: row.repo_id,
    worktreeId: row.worktree_id,
    agentKind: row.agent_kind,
    coordinationRole: row.coordination_role,
    cwd: row.cwd,
    displayName: row.display_name,
    lastCheckpointAt: row.last_checkpoint_at,
    joinedAt: row.joined_at
  };
  return row.current_plan
    ? { ...base, currentPlan: row.current_plan }
    : base;
}

interface InterventionRow {
  id: string;
  repo_id: string;
  conflict_id: string;
  target_agent_session_ids_json: string;
  draft: string;
  edited_direction: string;
  directive_json: string | null;
  status: Intervention["status"];
  created_at: number;
  sent_at: number | null;
  fetched_at: number | null;
  acknowledged_at: number | null;
}

interface AdvisoryRow {
  id: string;
  repo_id: string;
  conflict_id: string;
  options_json: string;
  source: Advisory["source"];
  created_at: number;
}

interface ConflictDecisionRow {
  id: string;
  repo_id: string;
  conflict_id: string;
  selected_option_id: string;
  selected_option_title: string;
  selected_option_direction: string;
  owner_agent_session_id: string | null;
  created_by: ConflictDecision["createdBy"];
  status: ConflictDecision["status"];
  created_at: number;
  updated_at: number;
}

interface ContractPublicationRow {
  id: string;
  repo_id: string;
  conflict_id: string;
  owner_agent_session_id: string;
  surface: string;
  shape_summary: string;
  files_json: string;
  created_at: number;
}

function conflictDecisionFromRow(row: ConflictDecisionRow): ConflictDecision {
  return {
    id: row.id,
    repoId: row.repo_id,
    conflictId: row.conflict_id,
    selectedOptionId: row.selected_option_id,
    selectedOptionTitle: row.selected_option_title,
    selectedOptionDirection: row.selected_option_direction,
    ...(row.owner_agent_session_id
      ? { ownerAgentSessionId: row.owner_agent_session_id }
      : {}),
    createdBy: row.created_by,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function advisoryFromRow(row: AdvisoryRow): Advisory {
  return {
    id: row.id,
    repoId: row.repo_id,
    conflictId: row.conflict_id,
    options: JSON.parse(row.options_json) as Advisory["options"],
    source: row.source,
    createdAt: row.created_at
  };
}

function contractPublicationFromRow(
  row: ContractPublicationRow
): ContractPublication {
  return {
    id: row.id,
    repoId: row.repo_id,
    conflictId: row.conflict_id,
    ownerAgentSessionId: row.owner_agent_session_id,
    surface: row.surface,
    shapeSummary: row.shape_summary,
    files: JSON.parse(row.files_json) as string[],
    createdAt: row.created_at
  };
}

function interventionFromRow(row: InterventionRow): Intervention {
  const base = {
    id: row.id,
    repoId: row.repo_id,
    conflictId: row.conflict_id,
    targetAgentSessionIds: JSON.parse(row.target_agent_session_ids_json) as string[],
    draft: row.draft,
    editedDirection: row.edited_direction,
    ...(row.directive_json
      ? { directive: JSON.parse(row.directive_json) as Intervention["directive"] }
      : {}),
    status: row.status,
    createdAt: row.created_at
  };
  return {
    ...base,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    ...(row.fetched_at ? { fetchedAt: row.fetched_at } : {}),
    ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {})
  };
}
