import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRebaseStore } from "./store.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import { worktreeIdFor } from "./ids.js";

describe("Rebase MCP tool handlers", () => {
  it("joins, records a plan, checkpoints risk, and fetches queued intervention", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const join = handlers.join({
      cwd: dir,
      agentKind: "codex",
      displayName: "Codex A"
    });
    expect(join.sessionId).toBeTruthy();

    const plan = handlers.plan({
      sessionId: join.sessionId,
      plan: "Add Task priority"
    });
    expect(plan.ok).toBe(true);

    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "medium",
      confidence: 0.8,
      type: "schema",
      title: "Task model overlap",
      summary: "Two worktrees touched Task model.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [join.worktreeId, "other-worktree"],
      affectedSurfaces: ["Task model"],
      evidence: ["Both fingerprints touch Task model"],
      riskReasons: [
        {
          label: "Shared contract root",
          detail: "Both worktrees touch Task contract surfaces.",
          weight: 90
        }
      ],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    const checkpoint = handlers.checkpoint({ sessionId: join.sessionId });
    expect(checkpoint.risk).toBe("medium");
    expect(checkpoint.pause).toBe(false);
    expect(checkpoint.notifications[0]).toContain("Task model overlap");
    expect(handlers.sessionState({ sessionId: join.sessionId }).activeRisks).toHaveLength(
      1
    );
    expect(handlers.collisionRisk({ sessionId: join.sessionId }).risk).toBe(
      "medium"
    );
    expect(
      store
        .listAgentSessions("repo-1")
        .find((session) => session.id === join.sessionId)?.lastCheckpointAt
    ).toBeGreaterThan(plan.ok ? 0 : 0);

    store.upsertIntervention({
      id: "int-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      targetAgentSessionIds: [join.sessionId],
      draft: "Coordinate Task fields.",
      editedDirection: "Pause and revise your plan around the Task model.",
      directive: {
        role: "adapter",
        conflict: "Task model overlap",
        peerAgentName: "Codex B",
        peerWorktreeId: "other-worktree",
        peerIntentSummary: "Peer is changing Task due dates.",
        sharedSurfaces: ["Task model"],
        sharedFiles: ["src/db/schema.ts"],
        nextAction: "Preserve peer contract while adapting your changes."
      },
      status: "queued",
      createdAt: 1778000000001
    });
    const checkpointWithDirection = handlers.checkpoint({ sessionId: join.sessionId });
    expect(checkpointWithDirection.notifications).toContain(
      "Rebase delivered 1 queued direction for this session."
    );
    expect(checkpointWithDirection.directions[0]?.editedDirection).toContain("Pause");

    const intervention = handlers.fetchIntervention({ sessionId: join.sessionId });
    expect(intervention.directions).toEqual([]);
    expect(checkpointWithDirection.directions[0]?.directive?.role).toBe("adapter");
    expect(JSON.stringify(checkpointWithDirection.directions[0])).not.toContain(
      "diff --git"
    );
    expect(JSON.stringify(checkpointWithDirection.directions[0]).length).toBeLessThanOrEqual(1200);
    expect(store.listQueuedInterventions("repo-1", join.sessionId)).toEqual([]);

    store.close();
  });

  it("does not locally synthesize coordination episodes in required RocketRide mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-rr-required-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store,
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide required"
        }),
        async runPipeline() {
          throw new Error("MCP sync should not call RocketRide directly");
        }
      }
    });

    const left = handlers.join({
      cwd: path.join(dir, "left"),
      agentKind: "codex",
      displayName: "left-agent"
    });
    const right = handlers.join({
      cwd: path.join(dir, "right"),
      agentKind: "codex",
      displayName: "right-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "type",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [left.worktreeId, right.worktreeId],
      affectedSurfaces: ["Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const checkpoint = handlers.checkpoint({ sessionId: left.sessionId });

    expect(checkpoint.coordinationEpisodes).toEqual([]);
    expect(checkpoint.workOrders).toEqual([]);
    expect(store.listCoordinationEpisodes("repo-1")).toEqual([]);

    store.close();
  });

  it("records one decision, delivers directions on checkpoint, and acknowledges receipt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-decision-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "owner"),
      agentKind: "codex",
      displayName: "priority-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "adapter"),
      agentKind: "codex",
      displayName: "due-date-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [
        {
          label: "Shared contract root",
          detail: "Both worktrees touch Task contract surfaces.",
          weight: 90
        }
      ],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const decision = handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection:
        "Make priority-agent owner and due-date-agent adapter.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });
    const duplicate = handlers.recordDecision({
      sessionId: adapter.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "contract-first",
      selectedOptionTitle: "Agree contract first",
      selectedOptionDirection: "Pause everyone.",
      createdBy: "dashboard"
    });

    expect(decision.alreadyDecided).toBe(false);
    expect(decision.interventions).toHaveLength(2);
    expect(duplicate.alreadyDecided).toBe(true);
    expect(duplicate.decision.id).toBe(decision.decision.id);

    const checkpoint = handlers.checkpoint({ sessionId: owner.sessionId });
    expect(checkpoint.directions).toHaveLength(1);
    expect(checkpoint.directions[0]?.status).toBe("queued");
    expect(checkpoint.directions[0]?.directive?.role).toBe("contract_owner");
    expect(checkpoint.directions[0]?.directive?.planSteps).toHaveLength(4);
    expect(store.listQueuedInterventions("repo-1", owner.sessionId)).toEqual([]);

    const acknowledged = handlers.acknowledgeIntervention({
      sessionId: owner.sessionId,
      interventionId: checkpoint.directions[0]?.id ?? ""
    });
    expect(acknowledged.ok).toBe(true);
    expect(
      store
        .listInterventions("repo-1")
        .find((item) => item.id === checkpoint.directions[0]?.id)?.status
    ).toBe("acknowledged");

    store.close();
  });

  it("defaults split ownership from agent chat to the recording session owner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-default-owner-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "label"),
      agentKind: "codex",
      displayName: "label-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "rich-title"),
      agentKind: "codex",
      displayName: "rich-title-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const decision = handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Split ownership across the active agents.",
      createdBy: "agent"
    });

    expect(decision.decision.ownerAgentSessionId).toBe(owner.sessionId);
    expect(
      decision.interventions.find((item) =>
        item.targetAgentSessionIds.includes(owner.sessionId)
      )?.directive?.role
    ).toBe("contract_owner");
    expect(
      decision.interventions.find((item) =>
        item.targetAgentSessionIds.includes(adapter.sessionId)
      )?.directive?.role
    ).toBe("adapter");

    store.close();
  });

  it("treats one user decision as episode-scoped across sibling conflicts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-episode-decision-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const labels = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const reminders = handlers.join({
      cwd: path.join(dir, "reminders"),
      agentKind: "codex",
      displayName: "reminders-agent"
    });
    const bulk = handlers.join({
      cwd: path.join(dir, "bulk"),
      agentKind: "codex",
      displayName: "bulk-agent"
    });
    for (const conflict of [
      {
        id: "conflict-labels-reminders",
        affectedWorktreeIds: [labels.worktreeId, reminders.worktreeId]
      },
      {
        id: "conflict-labels-bulk",
        affectedWorktreeIds: [labels.worktreeId, bulk.worktreeId]
      }
    ]) {
      store.upsertConflict({
        id: conflict.id,
        repoId: "repo-1",
        status: "open",
        risk: "high",
        confidence: 0.86,
        type: "schema",
        title: "Task contract overlap",
        summary: "Parallel worktrees touched the Task contract.",
        primarySurface: "Task contract",
        affectedWorktreeIds: conflict.affectedWorktreeIds,
        affectedSurfaces: ["Task type"],
        evidence: ["File overlap: src/shared/task.ts"],
        riskReasons: [],
        createdAt: 1778000000000,
        updatedAt: 1778000000000
      });
    }
    store.upsertCoordinationEpisode({
      id: "episode-task-contract",
      repoId: "repo-1",
      surface: "Task contract",
      status: "blocked",
      risk: "high",
      confidence: 0.9,
      affectedWorktreeIds: [labels.worktreeId, reminders.worktreeId, bulk.worktreeId],
      affectedAgentSessionIds: [
        labels.sessionId,
        reminders.sessionId,
        bulk.sessionId
      ],
      conflictIds: ["conflict-labels-reminders", "conflict-labels-bulk"],
      rocketRideRunIds: ["rr-1"],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const decision = handlers.recordDecision({
      sessionId: labels.sessionId,
      conflictId: "conflict-labels-reminders",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection:
        "Labels owns the integrated Task contract; other agents adapt.",
      ownerAgentSessionId: labels.sessionId,
      createdBy: "agent"
    });
    const staleSibling = handlers.recordDecision({
      sessionId: bulk.sessionId,
      conflictId: "conflict-labels-bulk",
      selectedOptionId: "pause",
      selectedOptionTitle: "Pause",
      selectedOptionDirection: "Pause this separate pairwise conflict.",
      createdBy: "agent"
    });
    const bulkCheckpoint = handlers.checkpoint({ sessionId: bulk.sessionId });

    expect(decision.alreadyDecided).toBe(false);
    expect(decision.interventions).toHaveLength(3);
    expect(staleSibling.alreadyDecided).toBe(true);
    expect(staleSibling.decision.id).toBe(decision.decision.id);
    expect(bulkCheckpoint.choices).toEqual([]);
    expect(bulkCheckpoint.activeDecisions).toHaveLength(1);

    store.close();
  });

  it("delivers an automatic work order before a manual decision, then later delivers the decision", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-manual-handoff-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "label"),
      agentKind: "codex",
      displayName: "label-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "rich-title"),
      agentKind: "codex",
      displayName: "rich-title-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const firstWait = await handlers.waitForDirection({
      sessionId: adapter.sessionId,
      timeoutMs: 1
    });
    expect(firstWait.timedOut).toBe(false);
    expect(firstWait.keepWaiting).toBe(false);
    expect(firstWait.workOrders[0]?.role).toBe("adapter");
    expect(firstWait.directions).toEqual([]);

    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Make label-agent the contract owner.",
      createdBy: "agent"
    });

    const delivered = await handlers.waitForDirection({
      sessionId: adapter.sessionId,
      timeoutMs: 1
    });
    expect(delivered.timedOut).toBe(false);
    expect(delivered.keepWaiting).toBe(false);
    expect(delivered.directions).toHaveLength(1);
    expect(delivered.directions[0]?.directive?.role).toBe("adapter");
    expect(store.listQueuedInterventions("repo-1", adapter.sessionId)).toEqual([]);

    const acknowledged = handlers.acknowledgeIntervention({
      sessionId: adapter.sessionId,
      interventionId: delivered.directions[0]?.id ?? ""
    });
    expect(acknowledged.ok).toBe(true);
    expect(
      store
        .listInterventions("repo-1")
        .find((item) => item.id === delivered.directions[0]?.id)?.status
    ).toBe("acknowledged");

    store.close();
  });

  it("activates RocketRide proposed work orders after an episode decision", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-proposed-work-order-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store,
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide required for test"
        }),
        async runPipeline() {
          throw new Error("Unexpected RocketRide pipeline run in MCP unit test");
        }
      }
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "reminders"),
      agentKind: "codex",
      displayName: "reminders-agent"
    });

    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertCoordinationEpisode({
      id: "episode-1",
      repoId: "repo-1",
      surface: "Task contract",
      status: "blocked",
      risk: "high",
      confidence: 0.9,
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedAgentSessionIds: [owner.sessionId, adapter.sessionId],
      conflictIds: ["conflict-1"],
      rocketRideRunIds: ["rr-work-order"],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertWorkOrder({
      id: "work-order-1",
      repoId: "repo-1",
      episodeId: "episode-1",
      agentSessionId: adapter.sessionId,
      role: "adapter",
      status: "superseded",
      revision: 1,
      title: "Adapt to Task contract",
      summary: "Adapt reminder fields to the owner contract.",
      requiredContract: "Preserve owner Task fields.",
      allowedFiles: ["src/components/ReminderPanel.tsx"],
      blockedFiles: ["src/shared/task.ts"],
      sharedFiles: ["src/shared/task.ts"],
      nextCheckpoint: "Checkpoint after adapting.",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const beforeDecision = await handlers.waitForDirection({
      sessionId: adapter.sessionId,
      timeoutMs: 1
    });
    expect(beforeDecision.workOrders).toEqual([]);
    expect(beforeDecision.keepWaiting).toBe(true);

    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "labels-agent owns the Task contract.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });

    const delivered = await handlers.waitForDirection({
      sessionId: adapter.sessionId,
      timeoutMs: 1
    });
    expect(delivered.workOrders).toHaveLength(1);
    expect(delivered.workOrders[0]).toMatchObject({
      id: "work-order-1",
      role: "adapter",
      status: "queued"
    });
    expect(
      store.listCoordinationEpisodes("repo-1").find((episode) => episode.id === "episode-1")
        ?.ownerAgentSessionId
    ).toBe(owner.sessionId);

    store.close();
  });

  it("does not re-offer choices after a decision but keeps the owner paused until contract publication", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-decided-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "label"),
      agentKind: "codex",
      displayName: "label-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "rich-title"),
      agentKind: "codex",
      displayName: "rich-title-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Make label-agent the contract owner.",
      createdBy: "agent"
    });

    const ownerCheckpoint = handlers.checkpoint({ sessionId: owner.sessionId });
    expect(ownerCheckpoint.directions).toHaveLength(1);
    expect(ownerCheckpoint.directions[0]?.directive?.role).toBe("contract_owner");

    const afterDecision = handlers.checkpoint({ sessionId: owner.sessionId });
    expect(afterDecision.risk).toBe("high");
    expect(afterDecision.pause).toBe(true);
    expect(afterDecision.keepWaiting).toBe(true);
    expect(afterDecision.choices).toEqual([]);
    expect(afterDecision.activeDecisions[0]?.selectedOptionTitle).toBe(
      "Split ownership"
    );
    expect(afterDecision.notifications.join("\n")).toContain(
      "missing published contract"
    );

    store.close();
  });

  it("downgrades conflicts that include an integration session to notices", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-integration-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const feature = handlers.join({
      cwd: path.join(dir, "feature"),
      agentKind: "codex",
      displayName: "label-agent"
    });
    const integration = handlers.join({
      cwd: path.join(dir, "main"),
      agentKind: "codex",
      displayName: "integration-main",
      coordinationRole: "integration"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [feature.worktreeId, integration.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const featureCheckpoint = handlers.checkpoint({ sessionId: feature.sessionId });
    const integrationCheckpoint = handlers.checkpoint({
      sessionId: integration.sessionId
    });

    expect(featureCheckpoint.risk).toBe("low");
    expect(featureCheckpoint.pause).toBe(false);
    expect(featureCheckpoint.choices).toEqual([]);
    expect(featureCheckpoint.notices[0]?.title).toBe("Task contract overlap");
    expect(integrationCheckpoint.risk).toBe("low");
    expect(integrationCheckpoint.pause).toBe(false);
    expect(integrationCheckpoint.notifications[0]).toContain(
      "Integration notice"
    );

    store.close();
  });

  it("keeps adapters waiting for owner publication and delivers the published shape", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-publication-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "label"),
      agentKind: "codex",
      displayName: "label-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "rich-title"),
      agentKind: "codex",
      displayName: "rich-title-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Make label-agent the contract owner.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });

    const initialAdapterDirection = handlers.checkpoint({
      sessionId: adapter.sessionId
    });
    expect(initialAdapterDirection.directions[0]?.directive?.role).toBe("adapter");

    store.updateConflictStatus("conflict-1", "resolved", 1778000000001);

    const waiting = await handlers.waitForDirection({
      sessionId: adapter.sessionId,
      timeoutMs: 1
    });
    expect(waiting.timedOut).toBe(true);
    expect(waiting.keepWaiting).toBe(true);
    expect(waiting.waitingOn).toEqual({
      type: "owner_contract_publication",
      conflictId: "conflict-1",
      ownerAgentSessionId: owner.sessionId
    });

    const publicationCheckpoint = handlers.checkpoint({
      sessionId: owner.sessionId,
      publishContract: {
        conflictId: "conflict-1",
        surface: "Task contract",
        shapeSummary:
          "Task keeps required label and adds title { text: string; subtitle: string }.",
        files: ["src/shared/task.ts", "src/db/schema.ts"]
      }
    });
    expect(publicationCheckpoint.publications[0]?.shapeSummary).toContain(
      "required label"
    );
    expect(store.listContractPublications("repo-1")).toHaveLength(1);

    const resumed = handlers.checkpoint({
      sessionId: adapter.sessionId
    });
    expect(resumed.directions[0]?.editedDirection).toContain("required label");
    expect(resumed.directions[0]?.directive?.role).toBe("adapter");
    expect(resumed.publications[0]?.shapeSummary).toContain("required label");

    store.close();
  });

  it("delivers split ownership direction to an affected agent that joins after the decision", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-late-decision-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "owner"),
      agentKind: "codex",
      displayName: "owner-agent"
    });
    const lateAdapterPath = path.join(dir, "late-adapter");
    const lateAdapterWorktreeId = worktreeIdFor(lateAdapterPath);
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, lateAdapterWorktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const decision = handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Make owner-agent the contract owner.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });
    expect(decision.interventions).toHaveLength(1);

    const lateAdapter = handlers.join({
      cwd: lateAdapterPath,
      agentKind: "codex",
      displayName: "late-adapter-agent"
    });
    const checkpoint = handlers.checkpoint({ sessionId: lateAdapter.sessionId });

    expect(checkpoint.directions).toHaveLength(1);
    expect(checkpoint.directions[0]?.directive?.role).toBe("adapter");
    expect(checkpoint.directions[0]?.editedDirection).toContain(
      "Pause Task contract edits until owner-agent checkpoints"
    );
    store.close();
  });

  it("delivers published owner shape to an affected agent that joins after publication", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-late-publication-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "owner"),
      agentKind: "codex",
      displayName: "owner-agent"
    });
    const lateAdapterPath = path.join(dir, "late-adapter");
    const lateAdapterWorktreeId = worktreeIdFor(lateAdapterPath);
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, lateAdapterWorktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Make owner-agent the contract owner.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });
    handlers.checkpoint({
      sessionId: owner.sessionId,
      publishContract: {
        conflictId: "conflict-1",
        surface: "Task contract",
        shapeSummary: "Task keeps label required and exposes title as a string.",
        files: ["src/shared/task.ts"]
      }
    });

    const lateAdapter = handlers.join({
      cwd: lateAdapterPath,
      agentKind: "codex",
      displayName: "late-adapter-agent"
    });
    const checkpoint = handlers.checkpoint({ sessionId: lateAdapter.sessionId });

    expect(checkpoint.directions).toHaveLength(1);
    expect(checkpoint.directions[0]?.directive?.role).toBe("adapter");
    expect(checkpoint.directions[0]?.editedDirection).toContain(
      "Owner published Task contract"
    );
    expect(checkpoint.directions[0]?.editedDirection).toContain("label required");
    expect(checkpoint.publications[0]?.shapeSummary).toContain("label required");

    store.close();
  });

  it("waits for queued directions and times out with current choices", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-wait-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const join = handlers.join({
      cwd: dir,
      agentKind: "codex",
      displayName: "Codex A"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.8,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [join.worktreeId],
      affectedSurfaces: ["Task model"],
      evidence: ["Both fingerprints touch Task model"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const timedOut = await handlers.waitForDirection({
      sessionId: join.sessionId,
      timeoutMs: 1
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.choices[0]?.options[0]?.title).toBe("Agree contract first");

    const waiting = handlers.waitForDirection({
      sessionId: join.sessionId,
      timeoutMs: 1000
    });
    setTimeout(() => {
      store.upsertIntervention({
        id: "int-wait",
        repoId: "repo-1",
        conflictId: "conflict-1",
        targetAgentSessionIds: [join.sessionId],
        draft: "Coordinate Task fields.",
        editedDirection: "Pause and agree Task contract.",
        status: "queued",
        createdAt: 1778000000001
      });
    }, 10);

    const delivered = await waiting;
    expect(delivered.timedOut).toBe(false);
    expect(delivered.directions[0]?.id).toBe("int-wait");
    expect(store.listQueuedInterventions("repo-1", join.sessionId)).toEqual([]);

    store.close();
  });

  it("returns work orders through checkpoint and wait so every affected agent gets delegated next steps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-work-orders-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapterA = handlers.join({
      cwd: path.join(dir, "reminders"),
      agentKind: "codex",
      displayName: "reminders-agent"
    });
    const adapterB = handlers.join({
      cwd: path.join(dir, "bulk-edit"),
      agentKind: "codex",
      displayName: "bulk-edit-agent"
    });
    store.upsertConflict({
      id: "conflict-ab",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.86,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapterA.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertConflict({
      id: "conflict-bc",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.82,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [adapterA.worktreeId, adapterB.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task type"],
      riskReasons: [],
      createdAt: 1778000000001,
      updatedAt: 1778000000001
    });

    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-ab",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "labels-agent owns the Task contract.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });

    const ownerCheckpoint = handlers.checkpoint({ sessionId: owner.sessionId });
    expect(ownerCheckpoint.workOrders).toHaveLength(1);
    expect(ownerCheckpoint.workOrders[0]?.role).toBe("contract_owner");
    expect(ownerCheckpoint.coordinationEpisodes[0]?.affectedAgentSessionIds).toHaveLength(3);
    expect(ownerCheckpoint.coordinationEpisodes[0]?.affectedAgentSessionIds).toEqual(
      expect.arrayContaining([
        owner.sessionId,
        adapterA.sessionId,
        adapterB.sessionId
      ])
    );

    const adapterWait = await handlers.waitForDirection({
      sessionId: adapterB.sessionId,
      timeoutMs: 1
    });
    expect(adapterWait.workOrders).toHaveLength(1);
    expect(adapterWait.workOrders[0]?.role).toBe("adapter");
    expect(adapterWait.workOrders[0]?.summary).toContain("labels-agent owns Task contract");
    expect(adapterWait.keepWaiting).toBe(false);

    store.close();
  });

  it("keeps fetched active work orders visible until a checkpoint completes them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-active-work-order-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "bulk"),
      agentKind: "codex",
      displayName: "bulk-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both worktrees changed src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "labels-agent owns the Task contract.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });

    const delivered = await handlers.waitForDirection({
      sessionId: adapter.sessionId,
      timeoutMs: 1
    });
    expect(delivered.workOrders[0]?.status).toBe("queued");

    const checkpoint = handlers.checkpoint({ sessionId: adapter.sessionId });
    expect(checkpoint.workOrders[0]).toMatchObject({
      id: delivered.workOrders[0]?.id,
      status: "fetched",
      role: "adapter"
    });

    store.close();
  });

  it("hard-pauses checkpoints when predictive merge-risk is blocked", () => {
    const store = createRebaseStore(":memory:");
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: "/tmp/repo",
      store,
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide pipelines validated."
        }),
        async runPipeline() {
          throw new Error("not used by checkpoint merge-risk read");
        }
      }
    });
    const session = handlers.join({
      cwd: "/tmp/repo/labels",
      agentKind: "codex",
      displayName: "labels-agent"
    });
    store.upsertCoordinationEpisode({
      id: "episode-1",
      repoId: "repo-1",
      surface: "Task contract",
      status: "blocked",
      risk: "high",
      confidence: 0.9,
      affectedWorktreeIds: [session.worktreeId],
      affectedAgentSessionIds: [session.sessionId],
      conflictIds: ["conflict-1"],
      rocketRideRunIds: ["rr-merge-risk-1"],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertMergeRiskAssessment({
      id: "merge-risk-1",
      repoId: "repo-1",
      episodeId: "episode-1",
      status: "blocked",
      risk: "high",
      safe: false,
      diffHash: "diff-a+diff-b",
      rocketRideRunId: "rr-merge-risk-1",
      predictedConflicts: [
        {
          id: "predicted-1",
          risk: "high",
          reasonCode: "same_hunk",
          summary: "Two worktrees edit the same Task hunk.",
          files: ["src/shared/task.ts"],
          symbols: ["Task"],
          affectedWorktreeIds: [session.worktreeId],
          evidence: ["Overlapping hunks in src/shared/task.ts"],
          blocking: true
        }
      ],
      warnings: [],
      requiredWorkOrders: ["work-order-agent-b-r1"],
      evidence: [
        {
          label: "Shared hunk",
          detail: "Both worktrees edit src/shared/task.ts.",
          files: ["src/shared/task.ts"],
          worktreeIds: [session.worktreeId]
        }
      ],
      createdAt: 1778000000000
    });

    const checkpoint = handlers.checkpoint({ sessionId: session.sessionId });

    expect(checkpoint.pause).toBe(true);
    expect(checkpoint.risk).toBe("high");
    expect(checkpoint.mergeRisks[0]?.status).toBe("blocked");
    expect(checkpoint.notifications.join("\n")).toContain(
      "Predictive merge risk blocked"
    );
    store.close();
  });

  it("publishes the active episode contract without requiring an agent to know the conflict id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-infer-contract-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "reminders"),
      agentKind: "codex",
      displayName: "reminders-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both worktrees changed src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "labels-agent owns the Task contract.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });

    const published = handlers.checkpoint({
      sessionId: owner.sessionId,
      publishContract: {
        surface: "Task contract",
        shapeSummary:
          "Task includes label, project, subtitle, reminderAt, archived, and batchId.",
        files: ["src/shared/task.ts"]
      } as Parameters<typeof handlers.checkpoint>[0]["publishContract"]
    });

    expect(published.publications[0]).toMatchObject({
      conflictId: "conflict-1",
      ownerAgentSessionId: owner.sessionId
    });
    const adapterCheckpoint = handlers.checkpoint({ sessionId: adapter.sessionId });
    expect(adapterCheckpoint.publications[0]?.shapeSummary).toContain("batchId");

    store.close();
  });

  it("publishes a multi-conflict episode contract without requiring an agent to know the conflict id", async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "rebase-mcp-infer-episode-contract-")
    );
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapterA = handlers.join({
      cwd: path.join(dir, "reminders"),
      agentKind: "codex",
      displayName: "reminders-agent"
    });
    const adapterB = handlers.join({
      cwd: path.join(dir, "bulk"),
      agentKind: "codex",
      displayName: "bulk-agent"
    });
    store.upsertConflict({
      id: "conflict-ab",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapterA.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both worktrees changed src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertConflict({
      id: "conflict-ac",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapterB.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both worktrees changed src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000001,
      updatedAt: 1778000000001
    });
    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-ab",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "labels-agent owns the Task contract.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });

    const published = handlers.checkpoint({
      sessionId: owner.sessionId,
      publishContract: {
        surface: "Task contract",
        shapeSummary:
          "Task includes label, project, subtitle, reminderAt, archived, and batchId.",
        files: ["src/shared/task.ts"]
      } as Parameters<typeof handlers.checkpoint>[0]["publishContract"]
    });

    expect(published.publications[0]).toMatchObject({
      ownerAgentSessionId: owner.sessionId
    });
    expect(published.publications[0]?.conflictId).toMatch(/^conflict-a[bc]$/);
    expect(
      handlers.checkpoint({ sessionId: adapterA.sessionId }).publications[0]
        ?.shapeSummary
    ).toContain("batchId");
    expect(
      handlers.checkpoint({ sessionId: adapterB.sessionId }).publications[0]
        ?.shapeSummary
    ).toContain("batchId");

    store.close();
  });

  it("treats same-checkpoint owner publication as satisfying the owner work order in required RocketRide mode", async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "rebase-mcp-required-owner-publication-")
    );
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store,
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide pipelines validated."
        }),
        async runPipeline() {
          throw new Error("not used by checkpoint publication");
        }
      }
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "reminders"),
      agentKind: "codex",
      displayName: "reminders-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both worktrees changed src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertCoordinationEpisode({
      id: "episode-1",
      repoId: "repo-1",
      surface: "Task contract",
      status: "coordinating",
      risk: "high",
      confidence: 0.9,
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedAgentSessionIds: [owner.sessionId, adapter.sessionId],
      conflictIds: ["conflict-1"],
      ownerAgentSessionId: owner.sessionId,
      rocketRideRunIds: ["rr-run-1"],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertWorkOrder({
      id: "work-order-owner",
      repoId: "repo-1",
      episodeId: "episode-1",
      agentSessionId: owner.sessionId,
      role: "contract_owner",
      status: "queued",
      revision: 1,
      title: "Own Task contract",
      summary: "Publish the canonical Task contract.",
      requiredContract: "labels-agent owns Task contract.",
      allowedFiles: ["src/shared/task.ts"],
      blockedFiles: [],
      sharedFiles: ["src/shared/task.ts"],
      nextCheckpoint: "Publish the owner contract.",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const published = handlers.checkpoint({
      sessionId: owner.sessionId,
      publishContract: {
        surface: "Task contract",
        shapeSummary:
          "Task includes label, project, subtitle, reminderAt, archived, and batchId.",
        files: ["src/shared/task.ts"]
      }
    });

    expect(published.pause).toBe(false);
    expect(store.listWorkOrders("repo-1")[0]?.status).toBe("completed");

    store.close();
  });

  it("pauses an adapter checkpoint until its fingerprint satisfies the active work order contract", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-mcp-enforce-work-order-"));
    const store = createRebaseStore(path.join(dir, "rebase.sqlite"));
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: dir,
      store
    });

    const owner = handlers.join({
      cwd: path.join(dir, "labels"),
      agentKind: "codex",
      displayName: "labels-agent"
    });
    const adapter = handlers.join({
      cwd: path.join(dir, "bulk"),
      agentKind: "codex",
      displayName: "bulk-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees touched Task contract.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [owner.worktreeId, adapter.worktreeId],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both worktrees changed src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    handlers.recordDecision({
      sessionId: owner.sessionId,
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "labels-agent owns the Task contract.",
      ownerAgentSessionId: owner.sessionId,
      createdBy: "agent"
    });
    handlers.checkpoint({
      sessionId: owner.sessionId,
      publishContract: {
        conflictId: "conflict-1",
        surface: "Task contract",
        shapeSummary:
          "Task includes label, project, subtitle, reminderAt, archived, and batchId.",
        files: ["src/shared/task.ts"]
      }
    });
    store.upsertFingerprint(makeFingerprint(adapter.worktreeId, "bulk-only", [
      "Task adds archived and batchId."
    ]));

    const blocked = handlers.checkpoint({ sessionId: adapter.sessionId });

    expect(blocked.pause).toBe(true);
    expect(blocked.notifications.join("\n")).toContain("missing label");

    store.upsertFingerprint(
      makeFingerprint(adapter.worktreeId, "combined", [
        "Task includes label, project, subtitle, reminderAt, archived, and batchId."
      ])
    );
    const completed = handlers.checkpoint({ sessionId: adapter.sessionId });

    expect(completed.pause).toBe(false);
    expect(
      store
        .listWorkOrders("repo-1")
        .find((order) => order.agentSessionId === adapter.sessionId)?.status
    ).toBe("completed");

    store.close();
  });

  it("does not auto-complete integration owner work orders before merge risk is safe", () => {
    const store = createRebaseStore(":memory:");
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: "/tmp/repo",
      store
    });
    const integration = handlers.join({
      cwd: "/tmp/repo/integration",
      agentKind: "codex",
      coordinationRole: "integration",
      displayName: "integration-agent"
    });
    store.upsertConflict({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.9,
      type: "schema",
      title: "Task contract overlap",
      summary: "Shared Task files still overlap.",
      primarySurface: "Task contract",
      affectedWorktreeIds: [integration.worktreeId, "peer-worktree"],
      affectedSurfaces: ["Task type"],
      evidence: ["File overlap: src/shared/task.ts"],
      riskReasons: [],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertCoordinationEpisode({
      id: "episode-1",
      repoId: "repo-1",
      surface: "Task contract",
      status: "blocked",
      risk: "high",
      confidence: 0.9,
      affectedWorktreeIds: [integration.worktreeId, "peer-worktree"],
      affectedAgentSessionIds: [integration.sessionId],
      conflictIds: ["conflict-1"],
      rocketRideRunIds: ["rr-1"],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertWorkOrder({
      id: "integration-order",
      repoId: "repo-1",
      episodeId: "episode-1",
      agentSessionId: integration.sessionId,
      role: "integration_owner",
      status: "queued",
      revision: 1,
      title: "Integrate Task files",
      summary: "Align exact overlapping Task files.",
      requiredContract: "Integrate exact file text.",
      allowedFiles: ["src/shared/task.ts"],
      blockedFiles: [],
      sharedFiles: ["src/shared/task.ts"],
      nextCheckpoint: "Checkpoint after RocketRide reports no blocking merge risk.",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const checkpoint = handlers.checkpoint({ sessionId: integration.sessionId });

    expect(checkpoint.pause).toBe(true);
    expect(checkpoint.notifications.join("\n")).toContain("safe merge risk");
    expect(store.listWorkOrders("repo-1")[0]?.status).toBe("fetched");
    store.close();
  });

  it("hard-pauses an adapter that still touches files blocked by its work order", () => {
    const store = createRebaseStore(":memory:");
    const handlers = createMcpToolHandlers({
      repoId: "repo-1",
      repoRoot: "/tmp/repo",
      store
    });
    const adapter = handlers.join({
      cwd: "/tmp/repo/adapter",
      agentKind: "codex",
      displayName: "adapter-agent"
    });
    store.upsertFingerprint({
      id: "fingerprint-1",
      repoId: "repo-1",
      worktreeId: adapter.worktreeId,
      diffHash: "diff-1",
      createdAt: 1778000000000,
      filesTouched: ["src/shared/task.ts", "src/components/TodoApp.tsx"],
      symbols: { added: [], modified: ["Task"], removed: [] },
      surfaces: [],
      semanticSummary: "Adapter still edits the Task contract.",
      contractChanges: [],
      confidence: 0.9,
      source: "heuristic"
    });
    store.upsertCoordinationEpisode({
      id: "episode-1",
      repoId: "repo-1",
      surface: "Task contract",
      status: "blocked",
      risk: "high",
      confidence: 0.9,
      affectedWorktreeIds: [adapter.worktreeId, "owner-worktree"],
      affectedAgentSessionIds: [adapter.sessionId],
      conflictIds: ["conflict-1"],
      rocketRideRunIds: ["rr-1"],
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    store.upsertWorkOrder({
      id: "adapter-order",
      repoId: "repo-1",
      episodeId: "episode-1",
      agentSessionId: adapter.sessionId,
      role: "adapter",
      status: "queued",
      revision: 1,
      title: "Adapt to Task contract",
      summary: "Stop editing shared Task files.",
      requiredContract: "Do not edit blocked shared files.",
      allowedFiles: ["src/components/**"],
      blockedFiles: ["src/shared/task.ts"],
      sharedFiles: ["src/shared/task.ts"],
      nextCheckpoint: "Checkpoint after removing blocked-file edits.",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    const checkpoint = handlers.checkpoint({ sessionId: adapter.sessionId });

    expect(checkpoint.pause).toBe(true);
    expect(checkpoint.notifications.join("\n")).toContain(
      "blocked files touched: src/shared/task.ts"
    );
    expect(store.listWorkOrders("repo-1")[0]?.status).toBe("fetched");
    store.close();
  });
});

function makeFingerprint(
  worktreeId: string,
  diffHash: string,
  contractChanges: string[]
) {
  return {
    id: `fingerprint-${diffHash}`,
    repoId: "repo-1",
    worktreeId,
    diffHash,
    createdAt: diffHash === "combined" ? 1778000000010 : 1778000000000,
    filesTouched: ["src/shared/task.ts"],
    symbols: {
      added: [],
      modified: ["Task"],
      removed: []
    },
    surfaces: [
      {
        id: `surface-${diffHash}`,
        label: "Task model",
        kind: "model" as const,
        files: ["src/shared/task.ts"],
        confidence: 0.9,
        evidence: contractChanges
      }
    ],
    semanticSummary: contractChanges.join(" "),
    contractChanges,
    confidence: 0.9,
    source: "heuristic" as const
  };
}
