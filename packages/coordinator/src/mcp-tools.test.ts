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

  it("keeps manual agents waiting across timeout and delivers a later decision", async () => {
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
    expect(firstWait.timedOut).toBe(true);
    expect(firstWait.keepWaiting).toBe(true);
    expect(firstWait.choices[0]?.title).toBe("Task contract overlap");
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

  it("does not keep pausing or re-offering choices after a conflict decision is active", async () => {
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
    expect(afterDecision.risk).toBe("low");
    expect(afterDecision.pause).toBe(false);
    expect(afterDecision.keepWaiting).toBe(false);
    expect(afterDecision.choices).toEqual([]);
    expect(afterDecision.activeDecisions[0]?.selectedOptionTitle).toBe(
      "Split ownership"
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
});
