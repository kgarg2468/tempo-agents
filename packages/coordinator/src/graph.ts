import type {
  AgentSession,
  Fingerprint,
  TempoConflict,
  TempoRepo,
  TempoWorktree
} from "@tempo/shared";
import type { TempoStore } from "./store.js";

export function upsertRepoGraph(
  store: TempoStore,
  repo: TempoRepo,
  updatedAt: number
): void {
  store.upsertGraphNode({
    id: `repo:${repo.id}`,
    repoId: repo.id,
    kind: "repo",
    label: repo.name,
    refId: repo.id,
    metadata: {
      rootPath: repo.rootPath
    },
    updatedAt
  });
}

export function upsertWorktreeGraph(
  store: TempoStore,
  worktree: TempoWorktree
): void {
  store.upsertGraphNode({
    id: `worktree:${worktree.id}`,
    repoId: worktree.repoId,
    kind: "worktree",
    label: worktree.branch ?? leaf(worktree.path),
    refId: worktree.id,
    metadata: {
      path: worktree.path,
      branch: worktree.branch,
      headSha: worktree.headSha,
      dirty: worktree.dirty,
      status: worktree.status
    },
    updatedAt: worktree.lastObservedAt
  });
  store.upsertGraphEdge({
    id: `repo:${worktree.repoId}->worktree:${worktree.id}`,
    repoId: worktree.repoId,
    sourceId: `repo:${worktree.repoId}`,
    targetId: `worktree:${worktree.id}`,
    kind: "contains",
    metadata: {
      branch: worktree.branch
    },
    updatedAt: worktree.lastObservedAt
  });
}

export function upsertAgentGraph(
  store: TempoStore,
  session: AgentSession,
  updatedAt: number
): void {
  store.upsertGraphNode({
    id: `agent:${session.id}`,
    repoId: session.repoId,
    kind: "agent",
    label: session.displayName,
    refId: session.id,
    metadata: {
      agentKind: session.agentKind,
      cwd: session.cwd,
      coordinationRole: session.coordinationRole ?? "feature"
    },
    updatedAt
  });
  if (!session.worktreeId) return;
  store.upsertGraphEdge({
    id: `agent:${session.id}->worktree:${session.worktreeId}`,
    repoId: session.repoId,
    sourceId: `agent:${session.id}`,
    targetId: `worktree:${session.worktreeId}`,
    kind: "runs_in",
    metadata: {},
    updatedAt
  });
}

export function upsertFingerprintGraph(
  store: TempoStore,
  fingerprint: Fingerprint
): void {
  for (const file of fingerprint.filesTouched) {
    const fileNodeId = `file:${file}`;
    store.upsertGraphNode({
      id: fileNodeId,
      repoId: fingerprint.repoId,
      kind: "file",
      label: file,
      refId: file,
      metadata: {},
      updatedAt: fingerprint.createdAt
    });
    store.upsertGraphEdge({
      id: `worktree:${fingerprint.worktreeId}->${fileNodeId}`,
      repoId: fingerprint.repoId,
      sourceId: `worktree:${fingerprint.worktreeId}`,
      targetId: fileNodeId,
      kind: "touches",
      metadata: {
        diffHash: fingerprint.diffHash
      },
      updatedAt: fingerprint.createdAt
    });
  }
  for (const surface of fingerprint.surfaces) {
    const surfaceNodeId = `surface:${surface.id}`;
    store.upsertGraphNode({
      id: surfaceNodeId,
      repoId: fingerprint.repoId,
      kind: "surface",
      label: surface.label,
      refId: surface.id,
      metadata: {
        kind: surface.kind,
        files: surface.files,
        confidence: surface.confidence
      },
      updatedAt: fingerprint.createdAt
    });
    store.upsertGraphEdge({
      id: `worktree:${fingerprint.worktreeId}->${surfaceNodeId}`,
      repoId: fingerprint.repoId,
      sourceId: `worktree:${fingerprint.worktreeId}`,
      targetId: surfaceNodeId,
      kind: "touches",
      metadata: {
        diffHash: fingerprint.diffHash
      },
      updatedAt: fingerprint.createdAt
    });
    for (const file of surface.files) {
      store.upsertGraphEdge({
        id: `${surfaceNodeId}->file:${file}`,
        repoId: fingerprint.repoId,
        sourceId: surfaceNodeId,
        targetId: `file:${file}`,
        kind: "relates_to",
        metadata: {},
        updatedAt: fingerprint.createdAt
      });
    }
  }
}

export function upsertConflictGraph(
  store: TempoStore,
  conflict: TempoConflict
): void {
  const conflictNodeId = `conflict:${conflict.id}`;
  store.upsertGraphNode({
    id: conflictNodeId,
    repoId: conflict.repoId,
    kind: "conflict",
    label: conflict.title,
    refId: conflict.id,
    metadata: {
      risk: conflict.risk,
      status: conflict.status,
      primarySurface: conflict.primarySurface
    },
    updatedAt: conflict.updatedAt
  });
  for (const worktreeId of conflict.affectedWorktreeIds) {
    store.upsertGraphEdge({
      id: `${conflictNodeId}->worktree:${worktreeId}`,
      repoId: conflict.repoId,
      sourceId: conflictNodeId,
      targetId: `worktree:${worktreeId}`,
      kind: "affects",
      metadata: {
        risk: conflict.risk
      },
      updatedAt: conflict.updatedAt
    });
  }
  for (const surface of conflict.affectedSurfaces) {
    const surfaceNodeId = `surface:${surfaceId(surface)}`;
    store.upsertGraphEdge({
      id: `${conflictNodeId}->${surfaceNodeId}`,
      repoId: conflict.repoId,
      sourceId: conflictNodeId,
      targetId: surfaceNodeId,
      kind: "affects",
      metadata: {
        risk: conflict.risk
      },
      updatedAt: conflict.updatedAt
    });
  }
}

function surfaceId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function leaf(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}
