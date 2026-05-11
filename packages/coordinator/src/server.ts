import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type {
  AgentSession,
  Fingerprint,
  HookEvent,
  RebaseConflict,
  RebaseEvent,
  RebaseWorktree
} from "@rebase/shared";
import { hookEventKindSchema } from "@rebase/shared";
import { findGitRoot } from "./git.js";
import { createRebaseStore, type RebaseStore } from "./store.js";
import { repoIdFor, stableId, worktreeIdFor } from "./ids.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { registerRebaseMcp } from "./mcp.js";
import { createRebaseWatcher, type RebaseWatcher } from "./watcher.js";
import {
  createDisabledRocketRideCoordinator,
  type RocketRideCoordinator
} from "./rocketride.js";
import { createHeuristicAdvisory } from "./advisory.js";
import {
  buildAgentSpecificDirective,
  directionFromDirective
} from "./guidance.js";
import { assembleEvidencePacket } from "./evidence.js";
import { upsertAgentGraph, upsertRepoGraph } from "./graph.js";

export interface CoordinatorOptions {
  repoRoot: string;
  dbPath: string;
  token: string;
  startWatcher?: boolean;
  rocketRide?: RocketRideCoordinator | undefined;
}

export async function createCoordinatorApp(
  options: CoordinatorOptions
): Promise<FastifyInstance> {
  await mkdir(path.dirname(options.dbPath), { recursive: true });
  const repoRoot = await findGitRoot(options.repoRoot);
  const store = createRebaseStore(options.dbPath);
  const rocketRide =
    options.rocketRide ??
    createDisabledRocketRideCoordinator(
      "RocketRide was not provided to this coordinator instance."
    );
  const now = Date.now();
  const repoId = repoIdFor(repoRoot);

  const repo = {
    id: repoId,
    rootPath: repoRoot,
    name: path.basename(repoRoot),
    createdAt: now,
    updatedAt: now
  };
  store.upsertRepo(repo);
  upsertRepoGraph(store, repo, now);
  store.addEvent({
    id: eventId("runtime.started", now),
    repoId,
    type: "runtime.started",
    message: "Coordinator started",
    payload: { repoRoot },
    createdAt: now
  });

  const app = Fastify({ logger: false });
  await app.register(websocket);
  const eventSubscribers = new Set<(event: unknown) => void>();
  const publishEvent = (event: unknown) => {
    for (const subscriber of eventSubscribers) {
      subscriber(event);
    }
  };
  const watcher = createRebaseWatcher({
    repoRoot,
    repoId,
    store,
    rocketRide,
    onEvent: publishEvent
  });
  if (options.startWatcher !== false) {
    await watcher.start();
  }

  app.addHook("onClose", async () => {
    await watcher.stop();
    store.close();
  });

  app.decorate("rebase", {
    repoRoot,
    repoId,
    token: options.token,
    store,
    watcher,
    rocketRide
  });

  app.get("/health", async (request) => ({
    ok: true,
    repoRoot,
    repoId,
    db: true,
    openai: Boolean(process.env.OPENAI_API_KEY),
    rocketRide: rocketRide.status(),
    mcpUrl: localUrl(request, "/mcp")
  }));

  app.get("/api/repo", async () => store.getRepo(repoId));

  app.get("/api/worktrees", async () => ({
    worktrees: listLiveWorktrees(store, repoId)
  }));

  app.get("/api/events", async () => ({
    events: listRuntimeEvents(store, repoId, now)
  }));

  app.get("/api/evidence", async () => ({
    evidencePackets: store.listEvidencePackets(repoId)
  }));

  app.get("/api/cloud-escalations", async () => ({
    cloudEscalationPackets: store.listCloudEscalationPackets(repoId)
  }));

  app.get("/api/graph", async () => ({
    nodes: store.listGraphNodes(repoId),
    edges: store.listGraphEdges(repoId)
  }));

  app.get("/api/events/stream", { websocket: true }, (socket) => {
    const send = (event: unknown) => {
      socket.send(JSON.stringify({ event }));
    };
    eventSubscribers.add(send);
    socket.send(JSON.stringify({ event: { type: "events.connected" } }));
    socket.on("close", () => {
      eventSubscribers.delete(send);
    });
  });

  app.get("/api/fingerprints", async () => ({
    fingerprints: listLiveFingerprints(store, repoId)
  }));

  app.get("/api/conflicts", async () => ({
    conflicts: listLiveConflicts(store, repoId)
  }));

  app.get("/api/agents", async () => ({
    agents: listLiveAgentSessions(store, repoId, now)
  }));

  app.get("/api/interventions", async () => ({
    interventions: store
      .listInterventions(repoId)
      .filter((intervention) =>
        liveConflictIds(store, repoId).has(intervention.conflictId)
      )
  }));

  app.get("/api/coordination-episodes", async () => ({
    coordinationEpisodes: store
      .listCoordinationEpisodes(repoId)
      .filter((episode) => episode.status !== "resolved")
  }));

  app.get("/api/work-orders", async () => ({
    workOrders: store
      .listWorkOrders(repoId)
      .filter((workOrder) =>
        store
          .listCoordinationEpisodes(repoId)
          .some(
            (episode) =>
              episode.id === workOrder.episodeId && episode.status !== "resolved"
          )
      )
  }));

  app.get("/api/merge-risks", async () => ({
    mergeRisks: store.listLatestMergeRiskAssessments(repoId)
  }));

  app.get("/api/decisions", async () => ({
    decisions: store
      .listConflictDecisions(repoId)
      .filter((decision) => liveConflictIds(store, repoId).has(decision.conflictId))
  }));

  app.get("/api/advisories", async () => ({
    advisories: store
      .listAdvisories(repoId)
      .filter((advisory) => liveConflictIds(store, repoId).has(advisory.conflictId))
  }));

  app.get("/api/contract-publications", async () => ({
    publications: store
      .listContractPublications(repoId)
      .filter((publication) =>
        liveConflictIds(store, repoId).has(publication.conflictId)
      )
  }));

  app.get("/api/export/events.jsonl", async (_request, reply) => {
    reply.type("application/x-ndjson");
    return store
      .listEvents(repoId)
      .map((event) => JSON.stringify(event))
      .join("\n");
  });

  app.get("/api/export/conflicts.jsonl", async (_request, reply) => {
    reply.type("application/x-ndjson");
    return store
      .listConflicts(repoId)
      .map((conflict) => JSON.stringify(conflict))
      .join("\n");
  });

  app.get("/api/settings", async (request) => ({
    openai: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini"
    },
    rocketRide: rocketRide.status(),
    codex: {
      mcpUrl: localUrl(request, "/mcp")
    }
  }));

  const mcpHandlers = createMcpToolHandlers({
    repoId,
    repoRoot,
    store,
    rocketRide
  });
  registerRebaseMcp(app, { repoId, repoRoot, store, rocketRide });

  app.post("/api/analyze", { preHandler: tokenAuth }, async () => {
    const result = await watcher.scanOnce();
    return {
      fingerprintCount: result.fingerprints.length,
      conflictCount: result.conflicts.length
    };
  });

  app.post(
    "/api/hooks/codex",
    { preHandler: tokenAuth },
    async (request) => {
      const body = codexHookBodySchema.parse(request.body);
      const receivedAt = body.receivedAt ?? Date.now();
      const cwd = body.cwd ?? repoRoot;
      await watcher.refreshWorktrees();
      const session = upsertHookSession({
        repoId,
        store,
        cwd,
        now: receivedAt,
        sessionId: body.sessionId,
        displayName: body.displayName,
        agentKind: body.agentKind
      });
      upsertAgentGraph(store, session, receivedAt);
      const hookEvent: HookEvent = {
        id: stableId(
          "hook",
          repoId,
          session.id,
          body.kind,
          String(receivedAt),
          String(store.listHookEvents(repoId, session.id).length)
        ),
        repoId,
        sessionId: session.id,
        worktreeId: session.worktreeId,
        agentKind: session.agentKind,
        cwd,
        kind: body.kind,
        receivedAt,
        ...(body.prompt ? { prompt: body.prompt } : {}),
        ...(body.toolName ? { toolName: body.toolName } : {}),
        ...(body.command ? { command: body.command } : {}),
        ...(body.outcome ? { outcome: body.outcome } : {}),
        filePaths: body.filePaths,
        metadata: body.metadata
      };
      store.upsertHookEvent(hookEvent);
      const packet = await assembleEvidencePacket({
        repoId,
        repoRoot,
        store,
        session,
        now: receivedAt
      });
      store.upsertEvidencePacket(packet);
      const prunedEvidencePackets = store.pruneExpiredEvidence(receivedAt);
      const runtimeEvent: RebaseEvent = {
        id: eventId("hook.codex.received", receivedAt),
        repoId,
        type: "hook.codex.received",
        message: `${session.displayName} sent ${body.kind}`,
        payload: {
          sessionId: session.id,
          worktreeId: session.worktreeId,
          evidencePacketId: packet.id
        },
        createdAt: receivedAt
      };
      store.addEvent(runtimeEvent);
      publishEvent(runtimeEvent);
      return {
        ok: true,
        sessionId: session.id,
        evidencePacketId: packet.id,
        prunedEvidencePackets
      };
    }
  );

  app.post(
    "/api/conflicts/:id/advisory",
    { preHandler: tokenAuth },
    async (request, reply) => {
      const params = request.params as { id: string };
      const conflict = store
        .listConflicts(repoId)
        .find((candidate) => candidate.id === params.id);
      if (!conflict) {
        return reply.code(404).send({ error: "Conflict not found" });
      }
      const advisory = createHeuristicAdvisory(conflict, Date.now());
      store.upsertAdvisory(advisory);
      return { advisory };
    }
  );

  app.post(
    "/api/interventions",
    { preHandler: tokenAuth },
    async (request) => {
      const now = Date.now();
      const body = z
        .object({
          conflictId: z.string().min(1),
          targetAgentSessionIds: z.array(z.string().min(1)),
          draft: z.string().min(1),
          editedDirection: z.string().min(1),
          ownerAgentSessionId: z.string().min(1).optional()
        })
        .parse(request.body);
      const conflict = store
        .listConflicts(repoId)
        .find((candidate) => candidate.id === body.conflictId);
      const agents = store.listAgentSessions(repoId);
      const fingerprints = store.listFingerprints(repoId);
      const interventions = body.targetAgentSessionIds.map((sessionId, index) => ({
        sessionId,
        index
      })).map(({ sessionId, index }) => {
        const directive = conflict
          ? buildAgentSpecificDirective({
              conflict,
              targetSessionId: sessionId,
              ownerSessionId: body.ownerAgentSessionId,
              agents,
              fingerprints,
              editedDirection: body.editedDirection
            })
          : undefined;
        const editedDirection =
          directive && body.ownerAgentSessionId
            ? directionFromDirective(directive, body.editedDirection)
            : body.editedDirection;
        return {
          id: stableId(
            "intervention",
            body.conflictId,
            sessionId,
            String(now),
            String(index)
          ),
          repoId,
          conflictId: body.conflictId,
          targetAgentSessionIds: [sessionId],
          draft: body.draft,
          editedDirection,
          ...(directive ? { directive } : {}),
          status: "queued" as const,
          createdAt: now,
          sentAt: now
        };
      });
      for (const intervention of interventions) {
        store.upsertIntervention(intervention);
      }
      return { intervention: interventions[0] ?? null, interventions };
    }
  );

  app.post(
    "/api/decisions",
    { preHandler: tokenAuth },
    async (request) => {
      const body = z
        .object({
          conflictId: z.string().min(1),
          selectedOptionId: z.string().min(1),
          selectedOptionTitle: z.string().min(1),
          selectedOptionDirection: z.string().min(1),
          ownerAgentSessionId: z.string().min(1).optional(),
          createdBy: z.enum(["dashboard", "agent"]).default("dashboard")
        })
        .parse(request.body);
      return mcpHandlers.recordDecision({
        conflictId: body.conflictId,
        selectedOptionId: body.selectedOptionId,
        selectedOptionTitle: body.selectedOptionTitle,
        selectedOptionDirection: body.selectedOptionDirection,
        ...(body.ownerAgentSessionId
          ? { ownerAgentSessionId: body.ownerAgentSessionId }
          : {}),
        createdBy: body.createdBy
      });
    }
  );

  app.post(
    "/api/mcp/join",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.join(request.body as Parameters<typeof mcpHandlers.join>[0])
  );

  app.post(
    "/api/mcp/plan",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.plan(request.body as Parameters<typeof mcpHandlers.plan>[0])
  );

  app.post(
    "/api/mcp/checkpoint",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.checkpoint(
        request.body as Parameters<typeof mcpHandlers.checkpoint>[0]
      )
  );

  app.post(
    "/api/mcp/fetch-intervention",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.fetchIntervention(
        request.body as Parameters<typeof mcpHandlers.fetchIntervention>[0]
      )
  );

  app.post(
    "/api/mcp/wait-for-direction",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.waitForDirection(
        request.body as Parameters<typeof mcpHandlers.waitForDirection>[0]
      )
  );

  app.post(
    "/api/mcp/record-decision",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.recordDecision(
        request.body as Parameters<typeof mcpHandlers.recordDecision>[0]
      )
  );

  app.post(
    "/api/mcp/acknowledge-intervention",
    { preHandler: tokenAuth },
    async (request) =>
      mcpHandlers.acknowledgeIntervention(
        request.body as Parameters<typeof mcpHandlers.acknowledgeIntervention>[0]
      )
  );

  app.post(
    "/api/conflicts/:id/status",
    { preHandler: tokenAuth },
    async (request, reply) => {
      const body = z
        .object({
          status: z.enum(["open", "acknowledged", "resolved", "ignored"])
        })
        .parse(request.body);
      const params = request.params as { id: string };
      store.updateConflictStatus(params.id, body.status, Date.now());
      return reply.send({ ok: true });
    }
  );

  return app;
}

async function tokenAuth(request: FastifyRequest, reply: FastifyReply) {
  const expected = request.server.rebase.token;
  const header = request.headers.authorization;
  const actual = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (actual !== expected) {
    await reply.code(401).send({ error: "Rebase local token required" });
  }
}

const codexHookBodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  agentKind: z.enum(["codex", "claude", "unknown"]).default("codex"),
  kind: hookEventKindSchema,
  receivedAt: z.number().optional(),
  prompt: z.string().optional(),
  toolName: z.string().optional(),
  command: z.string().optional(),
  outcome: z.string().optional(),
  filePaths: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

function upsertHookSession(input: {
  repoId: string;
  store: RebaseStore;
  cwd: string;
  now: number;
  sessionId?: string | undefined;
  displayName?: string | undefined;
  agentKind: AgentSession["agentKind"];
}): AgentSession {
  const worktreeId = worktreeIdFor(input.cwd);
  const existing = input.sessionId
    ? input.store
        .listAgentSessions(input.repoId)
        .find((session) => session.id === input.sessionId)
    : undefined;
  const knownWorktree = input.store
    .listWorktrees(input.repoId)
    .find((worktree) => worktree.id === worktreeId);
  if (!knownWorktree) {
    input.store.upsertWorktree({
      id: worktreeId,
      repoId: input.repoId,
      path: input.cwd,
      branch: null,
      headSha: null,
      dirty: false,
      status: "unjoined",
      lastObservedAt: input.now
    });
  }
  const session: AgentSession = {
    id: input.sessionId ?? stableId("hook-session", input.repoId, input.cwd),
    repoId: input.repoId,
    worktreeId,
    agentKind: input.agentKind,
    coordinationRole: existing?.coordinationRole ?? "feature",
    cwd: input.cwd,
    displayName:
      input.displayName ??
      existing?.displayName ??
      `${input.agentKind === "codex" ? "Codex" : "Agent"} ${path.basename(input.cwd)}`,
    ...(existing?.currentPlan ? { currentPlan: existing.currentPlan } : {}),
    lastCheckpointAt: input.now,
    joinedAt: existing?.joinedAt ?? input.now
  };
  input.store.upsertAgentSession(session);
  return session;
}

function listLiveWorktrees(
  store: RebaseStore,
  repoId: string
): RebaseWorktree[] {
  return store
    .listWorktrees(repoId)
    .filter((worktree) => worktree.status !== "missing");
}

function listLiveAgentSessions(
  store: RebaseStore,
  repoId: string,
  runtimeStartedAt: number
): AgentSession[] {
  const activeWorktreeIds = new Set(
    listLiveWorktrees(store, repoId).map((worktree) => worktree.id)
  );
  return store.listAgentSessions(repoId).filter((agent) => {
    const touchedThisRuntime =
      agent.joinedAt >= runtimeStartedAt ||
      (agent.lastCheckpointAt ?? 0) >= runtimeStartedAt;
    return (
      touchedThisRuntime &&
      (!agent.worktreeId || activeWorktreeIds.has(agent.worktreeId))
    );
  });
}

function listLiveFingerprints(
  store: RebaseStore,
  repoId: string
): Fingerprint[] {
  const dirtyWorktreeIds = liveDirtyWorktreeIds(store, repoId);
  const latestByWorktree = new Map<string, Fingerprint>();
  for (const fingerprint of store.listFingerprints(repoId)) {
    if (!dirtyWorktreeIds.has(fingerprint.worktreeId)) continue;
    const existing = latestByWorktree.get(fingerprint.worktreeId);
    if (!existing || fingerprint.createdAt > existing.createdAt) {
      latestByWorktree.set(fingerprint.worktreeId, fingerprint);
    }
  }
  return [...latestByWorktree.values()];
}

function listLiveConflicts(
  store: RebaseStore,
  repoId: string
): RebaseConflict[] {
  const dirtyWorktreeIds = liveDirtyWorktreeIds(store, repoId);
  return store
    .listConflicts(repoId)
    .filter((conflict) => {
      if (conflict.status === "resolved" || conflict.status === "ignored") {
        return false;
      }
      return conflict.affectedWorktreeIds.every((worktreeId) =>
        dirtyWorktreeIds.has(worktreeId)
      );
    })
    .map((conflict) => withIntegrationNotice(store, repoId, conflict));
}

function liveConflictIds(store: RebaseStore, repoId: string): Set<string> {
  return new Set(listLiveConflicts(store, repoId).map((conflict) => conflict.id));
}

function liveDirtyWorktreeIds(store: RebaseStore, repoId: string): Set<string> {
  return new Set(
    listLiveWorktrees(store, repoId)
      .filter((worktree) => worktree.dirty)
      .map((worktree) => worktree.id)
  );
}

function withIntegrationNotice(
  store: RebaseStore,
  repoId: string,
  conflict: RebaseConflict
): RebaseConflict {
  if (!conflictIncludesIntegrationSession(store, repoId, conflict)) return conflict;
  return {
    ...conflict,
    risk: "low",
    title: `${conflict.primarySurface} integration notice`,
    summary:
      "An integration session is converging existing feature work on this surface.",
    classification: {
      kind: "coordination_notice",
      rationale:
        "One affected worktree is an integration session, so this overlap is expected merge/convergence work.",
      source: "fallback",
      confidence: 0.9
    },
    riskReasons: [
      {
        label: "Integration session",
        detail:
          "Rebase is treating this overlap as final integration rather than parallel feature work.",
        weight: 20
      }
    ]
  };
}

function conflictIncludesIntegrationSession(
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

function listRuntimeEvents(
  store: RebaseStore,
  repoId: string,
  runtimeStartedAt: number
): RebaseEvent[] {
  return store
    .listEvents(repoId)
    .filter((event) => event.createdAt >= runtimeStartedAt);
}

function eventId(type: string, createdAt: number): string {
  return stableId(type, String(createdAt));
}

function localUrl(request: FastifyRequest, pathname: string): string {
  const host = request.headers.host ?? "127.0.0.1:3747";
  return `http://${host}${pathname}`;
}

declare module "fastify" {
  interface FastifyInstance {
    rebase: {
      repoRoot: string;
      repoId: string;
      token: string;
      store: RebaseStore;
      watcher: RebaseWatcher;
      rocketRide: RocketRideCoordinator;
    };
  }
}
