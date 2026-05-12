import { describe, expect, it } from "vitest";
import {
  compatibilityClassificationSchema,
  contractPublicationSchema,
  conflictDecisionSchema,
  conflictSchema,
  cloudEscalationPacketSchema,
  debateVerdictSchema,
  evidencePacketSchema,
  fingerprintSchema,
  graphEdgeSchema,
  graphNodeSchema,
  hookEventSchema,
  agentSessionSchema,
  interventionSchema,
  mergeRiskAssessmentSchema,
  coordinationPlanSchema,
  tokenCostEstimateSchema,
  workOrderSchema,
  worktreeSchema
} from "./index.js";

describe("shared schemas", () => {
  it("validates a worktree snapshot", () => {
    const parsed = worktreeSchema.parse({
      id: "wt-main",
      repoId: "repo-1",
      path: "/tmp/repo",
      branch: "main",
      headSha: "abc123",
      dirty: true,
      status: "active",
      lastObservedAt: 1778000000000
    });

    expect(parsed.status).toBe("active");
  });

  it("validates a live fingerprint without raw diff content", () => {
    const parsed = fingerprintSchema.parse({
      id: "fp-1",
      repoId: "repo-1",
      worktreeId: "wt-a",
      diffHash: "hash-1",
      createdAt: 1778000000000,
      filesTouched: ["src/db/schema.ts"],
      symbols: {
        added: ["Task.priority"],
        modified: ["Task"],
        removed: []
      },
      surfaces: [
        {
          id: "surface-task-model",
          label: "Task model",
          kind: "schema",
          files: ["src/db/schema.ts"],
          confidence: 0.86,
          evidence: ["schema filename", "Task interface"]
        }
      ],
      semanticSummary: "Adds priority to the Task model.",
      contractChanges: ["Task.priority"],
      confidence: 0.82,
      source: "heuristic"
    });

    expect(JSON.stringify(parsed)).not.toContain("@@");
  });

  it("validates agent coordination roles", () => {
    const parsed = agentSessionSchema.parse({
      id: "agent-integration",
      repoId: "repo-1",
      worktreeId: "wt-main",
      agentKind: "codex",
      cwd: "/tmp/repo",
      displayName: "integration-main",
      coordinationRole: "integration",
      lastCheckpointAt: 1778000000000,
      joinedAt: 1778000000000
    });

    expect(parsed.coordinationRole).toBe("integration");
  });

  it("validates a conflict lifecycle state", () => {
    const parsed = conflictSchema.parse({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "medium",
      confidence: 0.78,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees are changing Task contract surfaces.",
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
      createdAt: 1778000000000,
      updatedAt: 1778000000001
    });

    expect(parsed.status).toBe("open");
    expect(parsed.primarySurface).toBe("Task contract");
    expect(parsed.riskReasons[0]?.label).toBe("Shared contract root");
  });

  it("validates edited intervention direction", () => {
    const parsed = interventionSchema.parse({
      id: "int-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      targetAgentSessionIds: ["agent-1"],
      draft: "Coordinate Task fields before committing.",
      editedDirection: "Pause and revise your plan around the Task contract.",
      directive: {
        role: "adapter",
        conflict: "Task contract overlap",
        peerAgentName: "codex-due-date",
        peerWorktreeId: "wt-due",
        peerIntentSummary: "Peer is adding required dueDate to Task.",
        sharedSurfaces: ["Task model", "Task type"],
        sharedFiles: ["src/db/schema.ts"],
        nextAction: "Preserve dueDate while adapting priority work."
      },
      status: "queued",
      createdAt: 1778000000000
    });

    expect(parsed.status).toBe("queued");
    expect(parsed.directive?.role).toBe("adapter");
  });

  it("validates OpenAI coordination plans and integration-owner work orders", () => {
    const plan = coordinationPlanSchema.parse({
      source: "openai",
      strategy: "split_ownership",
      rationale: "One agent owns the contract while another integrates overlapping files.",
      ownerAgentSessionId: "agent-labels",
      integrationOwnerAgentSessionId: "agent-labels",
      workOrderIds: ["work-order-integration"],
      requiredTerms: ["Task.label is required"],
      validationChecklist: ["No same-hunk blockers remain"]
    });

    const order = workOrderSchema.parse({
      id: "work-order-integration",
      repoId: "repo-1",
      episodeId: "episode-1",
      agentSessionId: "agent-labels",
      role: "integration_owner",
      status: "queued",
      revision: 1,
      title: "Integrate Task contract files",
      summary: "Converge overlapping Task contract files to one text shape.",
      requiredContract: "Task includes labels, reminders, and bulk metadata.",
      allowedFiles: ["src/shared/task.ts", "src/app/api/tasks/route.ts"],
      blockedFiles: [],
      sharedFiles: ["src/shared/task.ts"],
      nextCheckpoint: "Checkpoint after overlapping files are text-compatible.",
      createdAt: 1778000000000,
      updatedAt: 1778000000000
    });

    expect(plan.source).toBe("openai");
    expect(order.role).toBe("integration_owner");
  });

  it("validates compatibility classification and conflict decisions", () => {
    const classification = compatibilityClassificationSchema.parse({
      kind: "coordination_notice",
      rationale: "Both worktrees add independent Task fields.",
      recommendedOwnerWorktreeId: "wt-priority",
      recommendedOptionId: "split-ownership",
      source: "openai",
      confidence: 0.82
    });
    expect(classification.kind).toBe("coordination_notice");
    expect(classification.source).toBe("openai");

    const decision = conflictDecisionSchema.parse({
      id: "decision-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      selectedOptionId: "split-ownership",
      selectedOptionTitle: "Split ownership",
      selectedOptionDirection: "Make priority the owner and due date the adapter.",
      createdBy: "agent",
      status: "active",
      createdAt: 1778000000000,
      updatedAt: 1778000000001
    });
    expect(decision.createdBy).toBe("agent");
  });

  it("validates an owner contract publication", () => {
    const parsed = contractPublicationSchema.parse({
      id: "publication-1",
      repoId: "repo-1",
      conflictId: "conflict-1",
      ownerAgentSessionId: "agent-owner",
      surface: "Task contract",
      shapeSummary: "Task has required label and structured title.",
      files: ["src/shared/task.ts"],
      createdAt: 1778000000002
    });

    expect(parsed.surface).toBe("Task contract");
    expect(parsed.files).toEqual(["src/shared/task.ts"]);
  });

  it("validates hook events, local evidence packets, and redacted cloud packets", () => {
    const hookEvent = hookEventSchema.parse({
      id: "hook-1",
      repoId: "repo-1",
      sessionId: "session-1",
      worktreeId: "wt-a",
      agentKind: "codex",
      cwd: "/tmp/repo-agent-a",
      kind: "post_tool_use",
      receivedAt: 1778000000000,
      toolName: "shell",
      command: "pnpm test",
      filePaths: ["src/db/schema.ts"],
      metadata: { exitCode: 0 }
    });
    expect(hookEvent.kind).toBe("post_tool_use");

    const packet = evidencePacketSchema.parse({
      id: "evidence-1",
      repoId: "repo-1",
      sessionId: "session-1",
      worktreeId: "wt-a",
      createdAt: 1778000000000,
      updatedAt: 1778000000001,
      expiresAt: 1778259200000,
      source: "mixed",
      hookEvents: [hookEvent],
      git: {
        branch: "agent-a",
        headSha: "abc123",
        mergeBase: "base123",
        diffHash: "diff123",
        filesTouched: ["src/db/schema.ts"],
        stats: {
          filesChanged: 1,
          insertions: 3,
          deletions: 1
        }
      },
      surfaces: [
        {
          id: "surface-task-model",
          label: "Task model",
          kind: "schema",
          files: ["src/db/schema.ts"],
          confidence: 0.86,
          evidence: ["schema filename", "Task interface"]
        }
      ],
      decisionHistory: [
        {
          id: "decision-1",
          conflictId: "conflict-1",
          summary: "Split Task ownership.",
          createdAt: 1778000000001
        }
      ],
      privacy: {
        retentionDays: 3,
        redactions: [],
        cloudEligible: false
      }
    });
    expect(packet.privacy.retentionDays).toBe(3);

    const cloudPacket = cloudEscalationPacketSchema.parse({
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
      createdAt: 1778000000002
    });
    expect(cloudPacket.status).toBe("candidate");
  });

  it("validates native code and decision graph facts", () => {
    const node = graphNodeSchema.parse({
      id: "surface:task-model",
      repoId: "repo-1",
      kind: "surface",
      label: "Task model",
      refId: "task-model",
      metadata: {
        files: ["src/db/schema.ts"]
      },
      updatedAt: 1778000000000
    });
    const edge = graphEdgeSchema.parse({
      id: "worktree:wt-a->surface:task-model",
      repoId: "repo-1",
      sourceId: "worktree:wt-a",
      targetId: "surface:task-model",
      kind: "touches",
      metadata: {
        diffHash: "hash-1"
      },
      updatedAt: 1778000000000
    });

    expect(node.kind).toBe("surface");
    expect(edge.kind).toBe("touches");
  });

  it("validates predictive merge-risk evidence", () => {
    const parsed = mergeRiskAssessmentSchema.parse({
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
          affectedWorktreeIds: ["wt-a", "wt-b"],
          evidence: ["Overlapping hunks in src/shared/task.ts"],
          blocking: true
        }
      ],
      warnings: [],
      requiredWorkOrders: ["work-order-agent-b-r1"],
      evidence: [
        {
          label: "Shared hunk",
          detail: "Both worktrees edit src/shared/task.ts near line 1.",
          files: ["src/shared/task.ts"],
          worktreeIds: ["wt-a", "wt-b"]
        }
      ],
      createdAt: 1778000000000
    });

    expect(parsed.status).toBe("blocked");
    expect(parsed.predictedConflicts[0]?.blocking).toBe(true);
  });

  it("rejects safe merge-risk assessments with blocking predicted conflicts", () => {
    expect(() =>
      mergeRiskAssessmentSchema.parse({
        id: "merge-risk-unsafe-safe",
        repoId: "repo-1",
        episodeId: "episode-1",
        status: "safe",
        risk: "low",
        safe: true,
        diffHash: "diff-a+diff-b",
        predictedConflicts: [
          {
            id: "predicted-1",
            risk: "high",
            reasonCode: "same_hunk",
            summary: "Two worktrees edit the same Task hunk.",
            files: ["src/shared/task.ts"],
            symbols: ["Task"],
            affectedWorktreeIds: ["wt-a", "wt-b"],
            evidence: ["Overlapping hunks in src/shared/task.ts"],
            blocking: true
          }
        ],
        warnings: [],
        requiredWorkOrders: [],
        evidence: [],
        createdAt: 1778000000000
      })
    ).toThrow("blocking predicted conflicts remain");
  });

  it("validates debate verdicts and token-cost estimates on conflicts", () => {
    const estimate = tokenCostEstimateSchema.parse({
      estimatedTokens: 1820,
      formula:
        "base + filesTouched*120 + touchedSurfaces*180 + confidence*200 + riskMultiplier*reworkMultiplier*250",
      inputs: {
        filesTouched: 2,
        touchedSurfaces: 4,
        confidence: 0.82,
        riskMultiplier: 2,
        reworkMultiplier: 2.5
      }
    });
    const debate = debateVerdictSchema.parse({
      verdict: "blocking",
      confidence: 0.82,
      proposer: "Both agents are editing the Task contract.",
      skeptic: "The edits may be additive, but both touch required fields.",
      judge: "Pause at checkpoint and choose an owner.",
      evidence: ["Shared contract root"],
      directions: ["Owner publishes Task shape.", "Adapter waits for shape."]
    });
    const conflict = conflictSchema.parse({
      id: "conflict-1",
      repoId: "repo-1",
      status: "open",
      risk: "high",
      confidence: 0.82,
      type: "schema",
      title: "Task contract overlap",
      summary: "Two worktrees are changing Task contract surfaces.",
      primarySurface: "Task contract",
      affectedWorktreeIds: ["wt-a", "wt-b"],
      affectedSurfaces: ["Task model", "Task type"],
      evidence: ["Both fingerprints touch Task model"],
      riskReasons: [],
      tokenCostEstimate: estimate,
      debate,
      createdAt: 1778000000000,
      updatedAt: 1778000000001
    });

    expect(conflict.debate?.verdict).toBe("blocking");
    expect(conflict.tokenCostEstimate?.estimatedTokens).toBe(1820);
  });
});
