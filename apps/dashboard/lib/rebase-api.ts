import type {
  AgentSession,
  Advisory,
  CloudEscalationPacket,
  ConflictDecision,
  ContractPublication,
  EvidencePacket,
  Fingerprint,
  Intervention,
  RebaseConflict,
  RebaseEvent,
  RebaseGraphEdge,
  RebaseGraphNode,
  RebaseRepo,
  RebaseWorktree
} from "@rebase/shared";

export interface RebaseSettings {
  openai: {
    configured: boolean;
    model: string;
  };
  codex: {
    mcpUrl: string;
  };
}

export interface RebaseSnapshot {
  connected: boolean;
  coordinatorUrl: string;
  repo: RebaseRepo | null;
  worktrees: RebaseWorktree[];
  agents: AgentSession[];
  fingerprints: Fingerprint[];
  conflicts: RebaseConflict[];
  advisories: Advisory[];
  interventions: Intervention[];
  decisions: ConflictDecision[];
  publications: ContractPublication[];
  evidencePackets: EvidencePacket[];
  cloudEscalationPackets: CloudEscalationPacket[];
  graph: {
    nodes: RebaseGraphNode[];
    edges: RebaseGraphEdge[];
  };
  events: RebaseEvent[];
  settings: RebaseSettings;
}

export const coordinatorUrl =
  process.env.REBASE_COORDINATOR_URL ??
  process.env.NEXT_PUBLIC_REBASE_COORDINATOR_URL ??
  "http://127.0.0.1:3747";

export async function getRebaseSnapshot(): Promise<RebaseSnapshot> {
  const [
    health,
    repo,
    worktrees,
    agents,
    fingerprints,
    conflicts,
    advisories,
    interventions,
    decisions,
    publications,
    evidencePackets,
    cloudEscalationPackets,
    graph,
    events,
    settings
  ] =
    await Promise.allSettled([
      fetchJson<{ ok: boolean }>("/health"),
      fetchJson<RebaseRepo | null>("/api/repo"),
      fetchJson<{ worktrees: RebaseWorktree[] }>("/api/worktrees"),
      fetchJson<{ agents: AgentSession[] }>("/api/agents"),
      fetchJson<{ fingerprints: Fingerprint[] }>("/api/fingerprints"),
      fetchJson<{ conflicts: RebaseConflict[] }>("/api/conflicts"),
      fetchJson<{ advisories: Advisory[] }>("/api/advisories"),
      fetchJson<{ interventions: Intervention[] }>("/api/interventions"),
      fetchJson<{ decisions: ConflictDecision[] }>("/api/decisions"),
      fetchJson<{ publications: ContractPublication[] }>(
        "/api/contract-publications"
      ),
      fetchJson<{ evidencePackets: EvidencePacket[] }>("/api/evidence"),
      fetchJson<{ cloudEscalationPackets: CloudEscalationPacket[] }>(
        "/api/cloud-escalations"
      ),
      fetchJson<{ nodes: RebaseGraphNode[]; edges: RebaseGraphEdge[] }>(
        "/api/graph"
      ),
      fetchJson<{ events: RebaseEvent[] }>("/api/events"),
      fetchJson<RebaseSettings>("/api/settings")
    ]);

  if (health.status === "rejected") {
    return demoModeEnabled() ? demoSnapshot(false) : disconnectedSnapshot();
  }

  return {
    connected: true,
    coordinatorUrl,
    repo: valueOr(repo, null),
    worktrees: valueOr(worktrees, { worktrees: [] }).worktrees,
    agents: valueOr(agents, { agents: [] }).agents,
    fingerprints: valueOr(fingerprints, { fingerprints: [] }).fingerprints,
    conflicts: valueOr(conflicts, { conflicts: [] }).conflicts,
    advisories: valueOr(advisories, { advisories: [] }).advisories,
    interventions: valueOr(interventions, { interventions: [] }).interventions,
    decisions: valueOr(decisions, { decisions: [] }).decisions,
    publications: valueOr(publications, { publications: [] }).publications,
    evidencePackets: valueOr(evidencePackets, { evidencePackets: [] })
      .evidencePackets,
    cloudEscalationPackets: valueOr(cloudEscalationPackets, {
      cloudEscalationPackets: []
    }).cloudEscalationPackets,
    graph: valueOr(graph, { nodes: [], edges: [] }),
    events: valueOr(events, { events: [] }).events,
    settings: valueOr(settings, demoSnapshot(true).settings)
  };
}

async function fetchJson<T>(pathname: string): Promise<T> {
  const response = await fetch(`${coordinatorUrl}${pathname}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Rebase coordinator returned ${response.status} for ${pathname}`);
  }
  return (await response.json()) as T;
}

function valueOr<T>(
  result: PromiseSettledResult<T>,
  fallback: T
): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function demoModeEnabled(): boolean {
  return (
    process.env.REBASE_DASHBOARD_DEMO_DATA === "1" ||
    process.env.NEXT_PUBLIC_REBASE_DASHBOARD_DEMO_DATA === "1"
  );
}

function disconnectedSnapshot(): RebaseSnapshot {
  return {
    connected: false,
    coordinatorUrl,
    repo: null,
    worktrees: [],
    agents: [],
    fingerprints: [],
    conflicts: [],
    advisories: [],
    interventions: [],
    decisions: [],
    publications: [],
    evidencePackets: [],
    cloudEscalationPackets: [],
    graph: {
      nodes: [],
      edges: []
    },
    events: [],
    settings: {
      openai: {
        configured: false,
        model: "unavailable"
      },
      codex: {
        mcpUrl: `${coordinatorUrl}/mcp`
      }
    }
  };
}

function demoSnapshot(connected: boolean): RebaseSnapshot {
  const now = 1778000000000;
  const repo: RebaseRepo = {
    id: "demo-repo",
    rootPath: "/path/to/todo-demo",
    name: "todo-demo",
    createdAt: now,
    updatedAt: now
  };
  const worktrees: RebaseWorktree[] = [
    {
      id: "wt-a",
      repoId: repo.id,
      path: "/path/to/todo-demo-agent-a",
      branch: "agent-a",
      headSha: "abc123",
      dirty: true,
      status: "active",
      lastObservedAt: now
    },
    {
      id: "wt-b",
      repoId: repo.id,
      path: "/path/to/todo-demo-agent-b",
      branch: "agent-b",
      headSha: "def456",
      dirty: true,
      status: "unjoined",
      lastObservedAt: now
    }
  ];
  const fingerprints: Fingerprint[] = worktrees.map((worktree, index) => ({
    id: `fp-${index}`,
    repoId: repo.id,
    worktreeId: worktree.id,
    diffHash: `hash-${index}`,
    createdAt: now + index,
    filesTouched: ["src/db/schema.ts"],
    symbols: {
      added: [],
      modified: ["Task"],
      removed: []
    },
    surfaces: [
      {
        id: "surface-task-model",
        label: "Task model",
        kind: "schema",
        files: ["src/db/schema.ts"],
        confidence: 0.78,
        evidence: ["schema.ts declares Task"]
      }
    ],
    semanticSummary:
      index === 0
        ? "Changes touch Task model priority fields."
        : "Changes touch Task model tags fields.",
    contractChanges: ["Task model"],
    confidence: 0.72,
    source: "heuristic"
  }));
  const conflicts: RebaseConflict[] = [
    {
      id: "conflict-task-model",
      repoId: repo.id,
      status: "open",
      risk: "medium",
      confidence: 0.8,
      type: "schema",
      title: "Task model overlap",
      summary: "Two worktrees are changing Task model.",
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
      createdAt: now,
      updatedAt: now
    }
  ];

  return {
    connected,
    coordinatorUrl,
    repo,
    worktrees,
    agents: [
      {
        id: "agent-a",
        repoId: repo.id,
        worktreeId: "wt-a",
        agentKind: "codex",
        coordinationRole: "feature",
        cwd: "/path/to/todo-demo-agent-a",
        displayName: "Codex A",
        currentPlan: "Add Task priority and update API response.",
        lastCheckpointAt: now - 8_000,
        joinedAt: now - 60_000
      }
    ],
    fingerprints,
    conflicts,
    advisories: [
      {
        id: "advisory-demo",
        repoId: repo.id,
        conflictId: "conflict-task-model",
        source: "heuristic",
        createdAt: now,
        options: [
          {
            id: "advisory-demo-option",
            title: "Agree contract first",
            direction:
              "Pause dependent edits and agree the Task model shape before changing API routes or TaskCard props.",
            rationale: "Both active fingerprints touch Task model.",
            affectedSurfaces: ["Task model"]
          }
        ]
      }
    ],
    interventions: [
      {
        id: "intervention-1",
        repoId: repo.id,
        conflictId: "conflict-task-model",
        targetAgentSessionIds: ["agent-a"],
        draft:
          "Pause and revise your plan around the Task contract before editing dependent API or component code.",
        editedDirection:
          "Coordinate the Task model shape first, then update routes and TaskCard props from that agreed contract.",
        status: "draft",
        createdAt: now
      }
    ],
    decisions: [],
    publications: [],
    evidencePackets: [
      {
        id: "evidence-demo",
        repoId: repo.id,
        sessionId: "agent-a",
        worktreeId: "wt-a",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3 * 24 * 60 * 60 * 1000,
        source: "mixed",
        promptSummary: "Add Task priority and update API response.",
        planSummary: "Add priority to Task.",
        hookEvents: [],
        git: {
          branch: "agent-a",
          headSha: "abc123",
          mergeBase: null,
          diffHash: "hash-0",
          filesTouched: ["src/db/schema.ts"],
          stats: {
            filesChanged: 1,
            insertions: 4,
            deletions: 1
          }
        },
        surfaces: fingerprints[0]?.surfaces ?? [],
        decisionHistory: [],
        privacy: {
          retentionDays: 3,
          redactions: [],
          cloudEligible: false
        }
      }
    ],
    cloudEscalationPackets: [
      {
        id: "cloud-demo",
        repoId: repo.id,
        conflictId: "conflict-task-model",
        evidencePacketIds: ["evidence-demo"],
        provider: "openai",
        reason: "medium Rebase collision candidate on Task contract",
        status: "candidate",
        redactions: ["secret"],
        redactedContext: {
          conflict: {
            title: "Task model overlap",
            primarySurface: "Task contract"
          }
        },
        createdAt: now
      }
    ],
    graph: {
      nodes: [],
      edges: []
    },
    events: [
      {
        id: "event-1",
        repoId: repo.id,
        type: "conflict.opened",
        message: "Task model overlap",
        payload: { conflictId: "conflict-task-model" },
        createdAt: now
      }
    ],
    settings: {
      openai: {
        configured: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini"
      },
      codex: {
        mcpUrl: `${coordinatorUrl}/mcp`
      }
    }
  };
}
