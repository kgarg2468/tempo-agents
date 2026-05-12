import { watch, type FSWatcher } from "chokidar";
import type {
  CoordinationEpisode,
  MergeRiskAssessment,
  RebaseConflict,
  RebaseEvent,
  RebaseWorktree
} from "@rebase/shared";
import { createHeuristicAdvisory } from "./advisory.js";
import { analyzeWorktreesOnce, type AnalyzeWorktreesResult } from "./analyzer.js";
import {
  getWorktreeDiff,
  listWorktrees,
  normalizeDiff,
  type GitWorktree
} from "./git.js";
import { stableId, worktreeIdFor } from "./ids.js";
import { createRebasePathFilter, type RebasePathFilter } from "./path-ignore.js";
import type { RebaseStore } from "./store.js";
import {
  upsertConflictGraph,
  upsertFingerprintGraph,
  upsertWorktreeGraph
} from "./graph.js";
import { withDebate } from "./debate.js";
import { createCloudEscalationCandidate } from "./escalation.js";
import { buildCoordinationEpisodes } from "./episodes.js";
import {
  parseCollisionRunOutput,
  parseMergeRiskRunOutput,
  parseWorkOrderRunOutput
} from "./rocketride-contracts.js";
import {
  isRocketRideRequired,
  runRocketRidePipeline,
  type RocketRideCoordinator
} from "./rocketride.js";

export interface RebaseWatcherOptions {
  repoRoot: string;
  repoId: string;
  store: RebaseStore;
  debounceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  onEvent?: (event: RebaseEvent) => void;
  rocketRide?: RocketRideCoordinator | undefined;
}

export interface RebaseWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  scanOnce(): Promise<AnalyzeWorktreesResult>;
  refreshWorktrees(): Promise<RebaseWorktree[]>;
  isIgnoredPath(filePath: string): boolean;
}

const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
export function createRebaseWatcher(options: RebaseWatcherOptions): RebaseWatcher {
  return new ChokidarRebaseWatcher(options);
}

class ChokidarRebaseWatcher implements RebaseWatcher {
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pathFilter: RebasePathFilter;
  private poller: ReturnType<typeof setInterval> | null = null;
  private eventCounter = 0;

  constructor(private readonly options: RebaseWatcherOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.pathFilter = createRebasePathFilter(options.repoRoot);
  }

  async start(): Promise<void> {
    await this.refreshWorktrees();
    this.poller = setInterval(() => {
      void this.refreshWorktrees();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()));
    this.watchers.clear();
  }

  async scanOnce(): Promise<AnalyzeWorktreesResult> {
    await this.refreshWorktrees();
    const result = await analyzeWorktreesOnce({
      repoRoot: this.options.repoRoot,
      repoId: this.options.repoId,
      rocketRide: this.options.rocketRide
    });
    await this.persistAnalysis(result);
    this.recordEvent("analysis.completed", "Rebase analyzed dirty worktrees", {
      fingerprintCount: result.fingerprints.length,
      conflictCount: result.conflicts.length
    });
    return result;
  }

  async refreshWorktrees(): Promise<RebaseWorktree[]> {
    const previousWorktrees = this.options.store.listWorktrees(this.options.repoId);
    const before = new Set(previousWorktrees.map((worktree) => worktree.id));
    const previousById = new Map(
      previousWorktrees.map((worktree) => [worktree.id, worktree])
    );
    const gitWorktrees = await listWorktrees(this.options.repoRoot);
    const observed = await Promise.all(
      gitWorktrees.map((worktree) => this.observeWorktree(worktree))
    );
    const activeIds = new Set(observed.map((worktree) => worktree.id));

    for (const worktree of observed) {
      this.options.store.upsertWorktree(worktree);
      upsertWorktreeGraph(this.options.store, worktree);
      this.ensureFsWatcher(worktree.path);
      if (!before.has(worktree.id)) {
        this.recordEvent("worktree.discovered", "Rebase discovered a git worktree", {
          worktreeId: worktree.id,
          path: worktree.path,
          branch: worktree.branch
        });
      }
      if (worktree.dirty && !previousById.get(worktree.id)?.dirty) {
        this.recordEvent("worktree.activity", "Rebase observed uncommitted work", {
          worktreeId: worktree.id,
          path: worktree.path,
          branch: worktree.branch
        });
      }
    }

    this.options.store.markMissingWorktrees(
      this.options.repoId,
      [...activeIds],
      this.now()
    );
    for (const [id, previous] of previousById) {
      if (activeIds.has(id) || previous.status === "missing") continue;
      await this.closeFsWatcher(previous.path);
      this.recordEvent("worktree.missing", "Git worktree is no longer present", {
        worktreeId: previous.id,
        path: previous.path,
        branch: previous.branch
      });
    }

    return observed;
  }

  isIgnoredPath(filePath: string): boolean {
    return this.pathFilter.isIgnoredPath(filePath);
  }

  private async observeWorktree(worktree: GitWorktree): Promise<RebaseWorktree> {
    const diff = await getWorktreeDiff(worktree.path);
    const normalized = normalizeDiff(this.pathFilter.filterDiff(diff));
    return {
      id: worktreeIdFor(worktree.path),
      repoId: this.options.repoId,
      path: worktree.path,
      branch: worktree.branch,
      headSha: worktree.headSha,
      dirty: normalized.length > 0,
      status: "active",
      lastObservedAt: this.now()
    };
  }

  private ensureFsWatcher(worktreePath: string): void {
    if (this.watchers.has(worktreePath)) return;
    const watcher = watch(worktreePath, {
      ignoreInitial: true,
      ignored: (filePath) => this.isIgnoredPath(filePath)
    });
    watcher.on("all", (_eventName, filePath) => {
      this.queueWorktreeScan(worktreePath, filePath);
    });
    this.watchers.set(worktreePath, watcher);
  }

  private async closeFsWatcher(worktreePath: string): Promise<void> {
    const watcher = this.watchers.get(worktreePath);
    if (!watcher) return;
    await watcher.close();
    this.watchers.delete(worktreePath);
  }

  private queueWorktreeScan(worktreePath: string, filePath: string): void {
    if (this.isIgnoredPath(filePath)) return;
    const previous = this.pending.get(worktreePath);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.pending.delete(worktreePath);
      void this.scanOnce();
    }, this.debounceMs);
    this.pending.set(worktreePath, timer);
  }

  private async persistAnalysis(result: AnalyzeWorktreesResult): Promise<void> {
    const existingConflicts = new Map(
      this.options.store
        .listConflicts(this.options.repoId)
        .map((conflict) => [conflict.id, conflict])
    );
    const activeConflictIds = new Set<string>();

    for (const fingerprint of result.fingerprints) {
      this.options.store.upsertFingerprint(fingerprint);
      upsertFingerprintGraph(this.options.store, fingerprint);
    }

    if (isRocketRideRequired(this.options.rocketRide)) {
      const coordinationRocketRideRunIds = [...result.rocketRideRunIds];
      const collisionRun = await runRocketRidePipeline(
        this.options.rocketRide,
        "rebase-collision",
        {
          fingerprints: result.fingerprints,
          plans: this.options.store.listAgentSessions(this.options.repoId),
          graphFacts: [],
          existingEpisodes: this.options.store.listCoordinationEpisodes(
            this.options.repoId
          ),
          activeDecisions: this.options.store.listConflictDecisions(
            this.options.repoId
          )
        }
      );
      if (!collisionRun) {
        throw new Error("RocketRide rebase-collision did not return a run");
      }
      coordinationRocketRideRunIds.push(collisionRun.runId);
      const collision = parseCollisionRunOutput(collisionRun.output);
      this.persistConflicts({
        conflicts: collision.conflicts,
        fingerprints: result.fingerprints,
        existingConflicts,
        activeConflictIds,
        useLocalDebate: false
      });
      this.resolveInactiveConflicts(existingConflicts, activeConflictIds);

      const workOrderRun = await runRocketRidePipeline(
        this.options.rocketRide,
        "rebase-work-order",
        {
          plannerMode: process.env.OPENAI_API_KEY ? "required" : "optional",
          conflicts: collision.conflicts,
          episodes: collision.episodes,
          agents: this.options.store.listAgentSessions(this.options.repoId),
          fingerprints: result.fingerprints,
          diffs: await this.diffsForFingerprints(result.fingerprints),
          decisions: this.options.store.listConflictDecisions(this.options.repoId),
          publications: this.options.store.listContractPublications(
            this.options.repoId
          ),
          existingWorkOrders: this.options.store.listWorkOrders(this.options.repoId)
        }
      );
      if (!workOrderRun) {
        throw new Error("RocketRide rebase-work-order did not return a run");
      }
      coordinationRocketRideRunIds.push(workOrderRun.runId);
      const workOrder = parseWorkOrderRunOutput(workOrderRun.output);
      const gatedCoordination = this.gateCoordinationUntilDecision({
        episodes: workOrder.episodes,
        workOrders: workOrder.workOrders
      });
      const episodesWithRocketRideRuns = workOrder.episodes.map((episode) =>
        withRocketRideRunIds(episode, coordinationRocketRideRunIds)
      );
      const episodesWithMergeRisk = await this.applyMergeRisk({
        episodes: episodesWithRocketRideRuns.map((episode) => {
          const gated = gatedCoordination.episodes.find(
            (candidate) => candidate.id === episode.id
          );
          return gated ? { ...episode, ownerAgentSessionId: gated.ownerAgentSessionId } : episode;
        }),
        workOrders: workOrder.workOrders,
        conflicts: collision.conflicts,
        fingerprints: result.fingerprints,
        rocketRideRunIds: coordinationRocketRideRunIds,
        createdAt: this.now()
      });
      this.persistCoordination({
        episodes: episodesWithMergeRisk,
        workOrders: gatedCoordination.workOrders
      });
      return;
    }

    for (const conflict of result.conflicts) {
      this.persistConflict({
        conflict,
        fingerprints: result.fingerprints,
        existingConflicts,
        activeConflictIds,
        useLocalDebate: true
      });
    }

    this.resolveInactiveConflicts(existingConflicts, activeConflictIds);

    const coordinationRocketRideRunIds = [...result.rocketRideRunIds];
    const collisionRun = await runRocketRidePipeline(
      this.options.rocketRide,
      "rebase-collision",
      {
        fingerprints: result.fingerprints,
        plans: this.options.store.listAgentSessions(this.options.repoId),
        graphFacts: [],
        activeDecisions: this.options.store.listConflictDecisions(this.options.repoId)
      }
    );
    if (collisionRun) coordinationRocketRideRunIds.push(collisionRun.runId);
    const workOrderRun = await runRocketRidePipeline(
      this.options.rocketRide,
      "rebase-work-order",
      {
        plannerMode: process.env.OPENAI_API_KEY ? "required" : "optional",
        conflicts: this.options.store.listConflicts(this.options.repoId),
        agents: this.options.store.listAgentSessions(this.options.repoId),
        fingerprints: result.fingerprints,
        diffs: await this.diffsForFingerprints(result.fingerprints),
        publications: this.options.store.listContractPublications(this.options.repoId)
      }
    );
    if (workOrderRun) coordinationRocketRideRunIds.push(workOrderRun.runId);

    const coordination = buildCoordinationEpisodes({
      repoId: this.options.repoId,
      conflicts: this.options.store.listConflicts(this.options.repoId),
      agents: this.options.store.listAgentSessions(this.options.repoId),
      decisions: this.options.store.listConflictDecisions(this.options.repoId),
      publications: this.options.store.listContractPublications(this.options.repoId),
      existingEpisodes: this.options.store.listCoordinationEpisodes(this.options.repoId),
      existingWorkOrders: this.options.store.listWorkOrders(this.options.repoId),
      rocketRideRunIds: coordinationRocketRideRunIds,
      createdAt: this.now()
    });
    this.persistCoordination(coordination);
  }

  private persistConflicts(input: {
    conflicts: RebaseConflict[];
    fingerprints: AnalyzeWorktreesResult["fingerprints"];
    existingConflicts: Map<string, RebaseConflict>;
    activeConflictIds: Set<string>;
    useLocalDebate: boolean;
  }): void {
    for (const conflict of input.conflicts) {
      this.persistConflict({ ...input, conflict });
    }
  }

  private persistConflict(input: {
    conflict: RebaseConflict;
    fingerprints: AnalyzeWorktreesResult["fingerprints"];
    existingConflicts: Map<string, RebaseConflict>;
    activeConflictIds: Set<string>;
    useLocalDebate: boolean;
  }): void {
    const existing = input.existingConflicts.get(input.conflict.id);
    input.activeConflictIds.add(input.conflict.id);
    const persistedConflict: RebaseConflict =
      existing?.status === "acknowledged"
        ? { ...input.conflict, status: "acknowledged", createdAt: existing.createdAt }
        : input.conflict;
    const finalConflict = input.useLocalDebate
      ? withDebate(persistedConflict, input.fingerprints)
      : persistedConflict;
    this.options.store.upsertConflict(finalConflict);
    upsertConflictGraph(this.options.store, finalConflict);
    if (finalConflict.risk !== "low") {
      this.options.store.upsertCloudEscalationPacket(
        createCloudEscalationCandidate({
          repoRoot: this.options.repoRoot,
          conflict: finalConflict,
          fingerprints: input.fingerprints,
          createdAt: this.now()
        })
      );
    }
    if (
      !this.options.store
        .listAdvisories(this.options.repoId)
        .some((advisory) => advisory.conflictId === finalConflict.id)
    ) {
      this.options.store.upsertAdvisory(
        createHeuristicAdvisory(finalConflict, this.now())
      );
    }
    this.recordEvent(existing ? "conflict.updated" : "conflict.opened", finalConflict.title, {
      conflictId: finalConflict.id,
      risk: finalConflict.risk,
      affectedSurfaces: finalConflict.affectedSurfaces
    });
  }

  private resolveInactiveConflicts(
    existingConflicts: Map<string, RebaseConflict>,
    activeConflictIds: Set<string>
  ): void {
    for (const conflict of existingConflicts.values()) {
      if (
        (conflict.status === "open" || conflict.status === "acknowledged") &&
        !activeConflictIds.has(conflict.id)
      ) {
        this.options.store.updateConflictStatus(
          conflict.id,
          "resolved",
          this.now()
        );
        this.recordEvent("conflict.resolved", conflict.title, {
          conflictId: conflict.id,
          affectedSurfaces: conflict.affectedSurfaces
        });
      }
    }
  }

  private persistCoordination(input: {
    episodes: CoordinationEpisode[];
    workOrders: Parameters<RebaseStore["upsertWorkOrder"]>[0][];
  }): void {
    const activeEpisodeIds = new Set(input.episodes.map((episode) => episode.id));
    for (const episode of input.episodes) {
      this.options.store.upsertCoordinationEpisode(episode);
    }
    for (const episode of this.options.store.listCoordinationEpisodes(
      this.options.repoId
    )) {
      if (episode.status !== "resolved" && !activeEpisodeIds.has(episode.id)) {
        this.options.store.upsertCoordinationEpisode({
          ...episode,
          status: "resolved",
          updatedAt: this.now()
        });
      }
    }
    for (const workOrder of input.workOrders) {
      this.options.store.upsertWorkOrder(workOrder);
    }
    for (const episode of input.episodes) {
      if (episode.status !== "coordinated" && episode.status !== "safe") continue;
      for (const conflictId of episode.conflictIds) {
        this.options.store.updateConflictStatus(conflictId, "resolved", this.now());
      }
    }
  }

  private gateCoordinationUntilDecision(input: {
    episodes: CoordinationEpisode[];
    workOrders: Parameters<RebaseStore["upsertWorkOrder"]>[0][];
  }): {
    episodes: CoordinationEpisode[];
    workOrders: Parameters<RebaseStore["upsertWorkOrder"]>[0][];
  } {
    const activeDecisionConflictIds = new Set(
      this.options.store
        .listConflictDecisions(this.options.repoId)
        .filter((decision) => decision.status === "active")
        .map((decision) => decision.conflictId)
    );
    const decidedEpisodeIds = new Set(
      input.episodes
        .filter((episode) =>
          episode.conflictIds.some((conflictId) =>
            activeDecisionConflictIds.has(conflictId)
          )
        )
        .map((episode) => episode.id)
    );

    return {
      episodes: input.episodes.map((episode) =>
        decidedEpisodeIds.has(episode.id)
          ? episode
          : {
              ...episode,
              ownerAgentSessionId: undefined
            }
      ),
      workOrders: input.workOrders.map((workOrder) =>
        decidedEpisodeIds.has(workOrder.episodeId)
          ? workOrder
          : {
              ...workOrder,
              status: "superseded" as const
            }
      )
    };
  }

  private async applyMergeRisk(input: {
    episodes: CoordinationEpisode[];
    workOrders: Parameters<RebaseStore["upsertWorkOrder"]>[0][];
    conflicts: RebaseConflict[];
    fingerprints: AnalyzeWorktreesResult["fingerprints"];
    rocketRideRunIds: string[];
    createdAt: number;
  }): Promise<CoordinationEpisode[]> {
    if (!isRocketRideRequired(this.options.rocketRide)) return input.episodes;
    const episodes: CoordinationEpisode[] = [];
    for (const episode of input.episodes) {
      const mergeRiskRun = await runRocketRidePipeline(
        this.options.rocketRide,
        "rebase-merge-risk",
        {
          repoId: this.options.repoId,
          episode,
          conflicts: input.conflicts.filter((conflict) =>
            episode.conflictIds.includes(conflict.id)
          ),
          fingerprints: input.fingerprints.filter((fingerprint) =>
            episode.affectedWorktreeIds.includes(fingerprint.worktreeId)
          ),
          workOrders: input.workOrders.filter(
            (workOrder) => workOrder.episodeId === episode.id
          ),
          agents: this.options.store.listAgentSessions(this.options.repoId),
          publications: this.options.store.listContractPublications(
            this.options.repoId
          ),
          existingMergeRisks: this.options.store.listLatestMergeRiskAssessments(
            this.options.repoId
          ),
          diffs: await this.mergeRiskDiffs(episode, input.fingerprints),
          createdAt: input.createdAt
        }
      );
      if (!mergeRiskRun) {
        throw new Error("RocketRide rebase-merge-risk did not return a run");
      }
      input.rocketRideRunIds.push(mergeRiskRun.runId);
      const parsed = parseMergeRiskRunOutput(mergeRiskRun.output).mergeRisk;
      const assessment: MergeRiskAssessment = {
        ...parsed,
        rocketRideRunId: parsed.rocketRideRunId ?? mergeRiskRun.runId
      };
      this.options.store.upsertMergeRiskAssessment(assessment);
      episodes.push(withMergeRisk(episode, assessment, mergeRiskRun.runId));
    }
    return episodes;
  }

  private async mergeRiskDiffs(
    episode: CoordinationEpisode,
    fingerprints: AnalyzeWorktreesResult["fingerprints"]
  ): Promise<Array<{ worktreeId: string; diffHash: string; diff: string }>> {
    const worktrees = new Map(
      this.options.store
        .listWorktrees(this.options.repoId)
        .map((worktree) => [worktree.id, worktree])
    );
    const fingerprintsByWorktree = new Map(
      fingerprints.map((fingerprint) => [fingerprint.worktreeId, fingerprint])
    );
    const diffs: Array<{ worktreeId: string; diffHash: string; diff: string }> = [];
    for (const worktreeId of episode.affectedWorktreeIds) {
      const worktree = worktrees.get(worktreeId);
      if (!worktree || worktree.status === "missing") continue;
      const diff = normalizeDiff(
        this.pathFilter.filterDiff(await getWorktreeDiff(worktree.path))
      );
      diffs.push({
        worktreeId,
        diffHash: fingerprintsByWorktree.get(worktreeId)?.diffHash ?? stableId(diff),
        diff
      });
    }
    return diffs;
  }

  private async diffsForFingerprints(
    fingerprints: AnalyzeWorktreesResult["fingerprints"]
  ): Promise<Array<{ worktreeId: string; diffHash: string; diff: string }>> {
    const worktrees = new Map(
      this.options.store
        .listWorktrees(this.options.repoId)
        .map((worktree) => [worktree.id, worktree])
    );
    const diffs: Array<{ worktreeId: string; diffHash: string; diff: string }> = [];
    for (const fingerprint of fingerprints) {
      const worktree = worktrees.get(fingerprint.worktreeId);
      if (!worktree || worktree.status === "missing") continue;
      const diff = normalizeDiff(
        this.pathFilter.filterDiff(await getWorktreeDiff(worktree.path))
      );
      diffs.push({
        worktreeId: fingerprint.worktreeId,
        diffHash: fingerprint.diffHash,
        diff
      });
    }
    return diffs;
  }

  private recordEvent(
    type: string,
    message: string,
    payload: Record<string, unknown>
  ): void {
    const createdAt = this.now();
    const event: RebaseEvent = {
      id: stableId(
        this.options.repoId,
        type,
        String(createdAt),
        String(this.eventCounter++)
      ),
      repoId: this.options.repoId,
      type,
      message,
      payload,
      createdAt
    };
    this.options.store.addEvent(event);
    this.options.onEvent?.(event);
  }
}

function withRocketRideRunIds(
  episode: CoordinationEpisode,
  rocketRideRunIds: string[]
): CoordinationEpisode {
  return {
    ...episode,
    rocketRideRunIds: uniqueInOrder([
      ...episode.rocketRideRunIds,
      ...rocketRideRunIds
    ])
  };
}

function withMergeRisk(
  episode: CoordinationEpisode,
  assessment: MergeRiskAssessment,
  rocketRideRunId: string
): CoordinationEpisode {
  const rocketRideRunIds = uniqueInOrder([
    ...episode.rocketRideRunIds,
    rocketRideRunId
  ]);
  if (!assessment.safe && assessment.risk === "high") {
    return {
      ...episode,
      status: "blocked",
      risk: "high",
      rocketRideRunIds
    };
  }
  if (
    assessment.safe &&
    assessment.status === "safe" &&
    assessment.predictedConflicts.every((conflict) => !conflict.blocking)
  ) {
    return {
      ...episode,
      status: "safe",
      risk: assessment.risk,
      rocketRideRunIds
    };
  }
  return {
    ...episode,
    risk: assessment.risk === "medium" ? "medium" : episode.risk,
    rocketRideRunIds
  };
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}
