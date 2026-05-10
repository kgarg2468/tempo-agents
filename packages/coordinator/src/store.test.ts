import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRebaseStore } from "./store.js";

describe("RebaseStore", () => {
  it("initializes tables and persists events across restarts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-store-"));
    const dbPath = path.join(dir, "rebase.sqlite");

    const first = createRebaseStore(dbPath);
    first.upsertRepo({
      id: "repo-1",
      rootPath: dir,
      name: "store-test",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
    first.addEvent({
      id: "event-1",
      repoId: "repo-1",
      type: "runtime.started",
      message: "Coordinator started",
      payload: { port: 3747 },
      createdAt: 1778000000001
    });
    first.close();

    const second = createRebaseStore(dbPath);
    expect(second.listEvents("repo-1")).toEqual([
      {
        id: "event-1",
        repoId: "repo-1",
        type: "runtime.started",
        message: "Coordinator started",
        payload: { port: 3747 },
        createdAt: 1778000000001
      }
    ]);
    second.close();
  });

  it("persists conflict lifecycle updates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-store-"));
    const dbPath = path.join(dir, "rebase.sqlite");
    const store = createRebaseStore(dbPath);

    store.upsertRepo({
      id: "repo-1",
      rootPath: dir,
      name: "store-test",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });
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
      affectedWorktreeIds: ["wt-a", "wt-b"],
      affectedSurfaces: ["Task model"],
      evidence: ["Both fingerprints touch Task model"],
      riskReasons: [
        {
          label: "Shared contract root",
          detail: "Both worktrees touch Task contract surfaces.",
          weight: 90
        }
      ],
      createdAt: 1778000000001,
      updatedAt: 1778000000001
    });
    store.updateConflictStatus("conflict-1", "acknowledged", 1778000000002);

    expect(store.listConflicts("repo-1")[0]?.status).toBe("acknowledged");
    store.close();
  });

  it("persists discovered worktrees", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-store-"));
    const dbPath = path.join(dir, "rebase.sqlite");
    const store = createRebaseStore(dbPath);

    store.upsertWorktree({
      id: "wt-1",
      repoId: "repo-1",
      path: path.join(dir, "agent-a"),
      branch: "agent-a",
      headSha: "abc123",
      dirty: true,
      status: "active",
      lastObservedAt: 1778000000003
    });

    expect(store.listWorktrees("repo-1")).toEqual([
      {
        id: "wt-1",
        repoId: "repo-1",
        path: path.join(dir, "agent-a"),
        branch: "agent-a",
        headSha: "abc123",
        dirty: true,
        status: "active",
        lastObservedAt: 1778000000003
      }
    ]);
    store.close();
  });

  it("marks worktrees missing when git no longer reports them", async () => {
    const store = createRebaseStore(":memory:");

    store.upsertWorktree({
      id: "wt-active",
      repoId: "repo-1",
      path: "/repo",
      branch: "main",
      headSha: "abc123",
      dirty: false,
      status: "active",
      lastObservedAt: 1778000000001
    });
    store.upsertWorktree({
      id: "wt-removed",
      repoId: "repo-1",
      path: "/repo-agent",
      branch: "agent",
      headSha: "abc123",
      dirty: false,
      status: "active",
      lastObservedAt: 1778000000001
    });

    store.markMissingWorktrees("repo-1", ["wt-active"], 1778000000002);

    expect(
      store.listWorktrees("repo-1").map((worktree) => ({
        id: worktree.id,
        status: worktree.status
      }))
    ).toEqual([
      { id: "wt-active", status: "active" },
      { id: "wt-removed", status: "missing" }
    ]);
    store.close();
  });

  it("lists intervention history", async () => {
    const store = createRebaseStore(":memory:");

    store.upsertIntervention({
      id: "intervention-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      targetAgentSessionIds: ["agent-1"],
      draft: "Pause and reconcile the Task model.",
      editedDirection: "Coordinate the Task model before updating routes.",
      directive: {
        role: "contract_owner",
        conflict: "Task model overlap",
        peerAgentName: "codex-due-date",
        peerWorktreeId: "wt-due",
        peerIntentSummary: "Peer intent unknown.",
        sharedSurfaces: ["Task model"],
        sharedFiles: ["src/db/schema.ts"],
        nextAction: "Checkpoint the final Task contract shape."
      },
      status: "queued",
      createdAt: 1778000000004,
      sentAt: 1778000000005
    });

    expect(store.listInterventions("repo-1")).toHaveLength(1);
    expect(store.listInterventions("repo-1")[0]?.editedDirection).toBe(
      "Coordinate the Task model before updating routes."
    );
    expect(store.listInterventions("repo-1")[0]?.directive?.role).toBe(
      "contract_owner"
    );
    store.close();
  });

  it("persists advisory options separately from interventions", async () => {
    const store = createRebaseStore(":memory:");

    store.upsertAdvisory({
      id: "advisory-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      source: "heuristic",
      createdAt: 1778000000006,
      options: [
        {
          id: "option-1",
          title: "Agree contract first",
          direction: "Pause dependent edits until the Task model shape is agreed.",
          rationale: "Both worktrees touch Task model.",
          affectedSurfaces: ["Task model"]
        }
      ]
    });

    expect(store.listAdvisories("repo-1")[0]?.options[0]?.title).toBe(
      "Agree contract first"
    );
    store.close();
  });

  it("persists owner contract publications", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rebase-store-publication-"));
    const dbPath = path.join(dir, "rebase.sqlite");

    const first = createRebaseStore(dbPath);
    first.upsertContractPublication({
      id: "publication-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      ownerAgentSessionId: "agent-owner",
      surface: "Task contract",
      shapeSummary: "Task keeps required label and adds title { text, subtitle }.",
      files: ["src/shared/task.ts", "src/db/schema.ts"],
      createdAt: 1778000000007
    });
    first.close();

    const second = createRebaseStore(dbPath);
    expect(second.listContractPublications("repo-1")).toEqual([
      {
        id: "publication-1",
        repoId: "repo-1",
        conflictId: "conflict-1",
        ownerAgentSessionId: "agent-owner",
        surface: "Task contract",
        shapeSummary:
          "Task keeps required label and adds title { text, subtitle }.",
        files: ["src/shared/task.ts", "src/db/schema.ts"],
        createdAt: 1778000000007
      }
    ]);
    second.close();
  });

  it("persists coordination episodes and queued work orders", () => {
    const store = createRebaseStore(":memory:");

    store.upsertCoordinationEpisode({
      id: "episode-1",
      repoId: "repo-1",
      surface: "Task contract",
      status: "coordinating",
      risk: "high",
      confidence: 0.88,
      affectedWorktreeIds: ["wt-a", "wt-b", "wt-c"],
      affectedAgentSessionIds: ["agent-a", "agent-b", "agent-c"],
      conflictIds: ["conflict-ab", "conflict-bc"],
      ownerAgentSessionId: "agent-a",
      mergeContract: {
        id: "merge-contract-1",
        repoId: "repo-1",
        episodeId: "episode-1",
        surface: "Task contract",
        ownerAgentSessionId: "agent-a",
        summary: "Task keeps title:string and adds label.",
        files: ["src/shared/task.ts"],
        updatedAt: 1778000000009
      },
      rocketRideRunIds: ["rocketride-run-1"],
      createdAt: 1778000000008,
      updatedAt: 1778000000009
    });
    store.upsertWorkOrder({
      id: "work-order-1",
      repoId: "repo-1",
      episodeId: "episode-1",
      agentSessionId: "agent-b",
      role: "adapter",
      status: "queued",
      revision: 2,
      title: "Adapt to Task contract",
      summary: "Agent A owns Task contract. Adapt this worktree.",
      requiredContract: "Task keeps title:string and adds label.",
      allowedFiles: [],
      blockedFiles: [],
      sharedFiles: ["src/shared/task.ts"],
      nextCheckpoint: "Checkpoint after adapting to the owner contract.",
      createdAt: 1778000000010,
      updatedAt: 1778000000010
    });

    expect(store.listCoordinationEpisodes("repo-1")[0]?.mergeContract?.summary).toContain(
      "title:string"
    );
    expect(store.listQueuedWorkOrders("repo-1", "agent-b")).toHaveLength(1);
    store.markWorkOrderFetched("work-order-1", 1778000000011);
    expect(store.listQueuedWorkOrders("repo-1", "agent-b")).toEqual([]);
    expect(store.listWorkOrders("repo-1")[0]).toMatchObject({
      id: "work-order-1",
      status: "fetched",
      deliveredAt: 1778000000011
    });
    store.close();
  });

  it("persists evidence packets and prunes expired local evidence", async () => {
    const store = createRebaseStore(":memory:");
    store.upsertHookEvent({
      id: "hook-1",
      repoId: "repo-1",
      sessionId: "session-1",
      worktreeId: "wt-a",
      agentKind: "codex",
      cwd: "/tmp/repo-agent-a",
      kind: "user_prompt_submit",
      receivedAt: 1778000000000,
      prompt: "Add Task priority.",
      filePaths: [],
      metadata: {}
    });
    store.upsertEvidencePacket({
      id: "evidence-active",
      repoId: "repo-1",
      sessionId: "session-1",
      worktreeId: "wt-a",
      createdAt: 1778000000000,
      updatedAt: 1778000000000,
      expiresAt: 1778259200000,
      source: "hooks",
      hookEvents: store.listHookEvents("repo-1", "session-1"),
      git: {
        branch: "agent-a",
        headSha: "abc123",
        mergeBase: null,
        diffHash: null,
        filesTouched: [],
        stats: {
          filesChanged: 0,
          insertions: 0,
          deletions: 0
        }
      },
      surfaces: [],
      decisionHistory: [],
      privacy: {
        retentionDays: 3,
        redactions: [],
        cloudEligible: false
      }
    });
    store.upsertEvidencePacket({
      id: "evidence-expired",
      repoId: "repo-1",
      sessionId: "session-2",
      worktreeId: "wt-b",
      createdAt: 1777000000000,
      updatedAt: 1777000000000,
      expiresAt: 1777259200000,
      source: "hooks",
      hookEvents: [],
      git: {
        branch: null,
        headSha: null,
        mergeBase: null,
        diffHash: null,
        filesTouched: [],
        stats: {
          filesChanged: 0,
          insertions: 0,
          deletions: 0
        }
      },
      surfaces: [],
      decisionHistory: [],
      privacy: {
        retentionDays: 3,
        redactions: [],
        cloudEligible: false
      }
    });

    expect(store.listEvidencePackets("repo-1")).toHaveLength(2);
    expect(store.pruneExpiredEvidence(1778000000000)).toBe(1);
    expect(store.listEvidencePackets("repo-1").map((packet) => packet.id)).toEqual([
      "evidence-active"
    ]);
    store.close();
  });

  it("persists cloud escalation packet redaction records", () => {
    const store = createRebaseStore(":memory:");
    store.upsertCloudEscalationPacket({
      id: "cloud-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      evidencePacketIds: ["evidence-1"],
      provider: "openai",
      reason: "Medium/high collision candidate",
      status: "candidate",
      redactions: ["secret", "path:.env"],
      redactedContext: {
        prompt: "[REDACTED_SECRET]",
        filesTouched: ["[REDACTED_PATH]"]
      },
      createdAt: 1778000000000
    });

    expect(store.listCloudEscalationPackets("repo-1")[0]).toMatchObject({
      id: "cloud-1",
      redactions: ["secret", "path:.env"],
      status: "candidate"
    });
    store.close();
  });

  it("persists native graph facts and links decisions to conflicts", () => {
    const store = createRebaseStore(":memory:");
    store.upsertGraphNode({
      id: "surface:task-model",
      repoId: "repo-1",
      kind: "surface",
      label: "Task model",
      refId: "task-model",
      metadata: { files: ["src/db/schema.ts"] },
      updatedAt: 1778000000000
    });
    store.upsertConflictDecision({
      id: "decision-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      selectedOptionId: "split",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Task model owner goes first.",
      createdBy: "dashboard",
      status: "active",
      createdAt: 1778000000001,
      updatedAt: 1778000000001
    });

    expect(store.listGraphNodes("repo-1").map((node) => node.kind)).toEqual([
      "decision",
      "surface"
    ]);
    expect(store.listGraphEdges("repo-1")[0]).toMatchObject({
      sourceId: "decision:decision-1",
      targetId: "conflict:conflict-1",
      kind: "decides"
    });
    store.close();
  });
});
