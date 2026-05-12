import { PageHeader } from "../../../components/page-header";
import { getTempoSnapshot } from "../../../lib/tempo-api";

export default async function AgentsPage() {
  const snapshot = await getTempoSnapshot();
  const joinedWorktrees = new Set(
    snapshot.agents.map((agent) => agent.worktreeId).filter(Boolean)
  );
  const latestFingerprintByWorktree = new Map<
    string,
    (typeof snapshot.fingerprints)[number]
  >();
  for (const fingerprint of snapshot.fingerprints) {
    if (!latestFingerprintByWorktree.has(fingerprint.worktreeId)) {
      latestFingerprintByWorktree.set(fingerprint.worktreeId, fingerprint);
    }
  }
  const queuedInterventionsByAgent = new Map<string, number>();
  for (const intervention of snapshot.interventions) {
    if (intervention.status !== "queued") continue;
    for (const agentId of intervention.targetAgentSessionIds) {
      queuedInterventionsByAgent.set(
        agentId,
        (queuedInterventionsByAgent.get(agentId) ?? 0) + 1
      );
    }
  }
  const unjoined = snapshot.worktrees.filter(
    (worktree) => worktree.dirty && !joinedWorktrees.has(worktree.id)
  );

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Joined Codex sessions, unjoined worktrees, and checkpoint freshness."
      />
      <div className="panel-list">
        {snapshot.agents.map((agent) => (
          <div className="row-panel" key={agent.id}>
            <div className="row-title">
              <span>{agent.displayName}</span>
              <span className="muted small">
                {checkpointLabel(agent.lastCheckpointAt)}
              </span>
            </div>
            <p className="muted small">
              {agent.currentPlan ? `Plan: ${agent.currentPlan}` : `cwd: ${agent.cwd}`}
            </p>
            <div className="agent-meta">
              <span className="status-pill">
                queued directions: {queuedInterventionsByAgent.get(agent.id) ?? 0}
              </span>
              {agent.worktreeId ? (
                <span className="status-pill">
                  {latestFingerprintByWorktree.get(agent.worktreeId)?.source ??
                    "no fingerprint"}
                </span>
              ) : null}
            </div>
            {agent.worktreeId &&
            latestFingerprintByWorktree.has(agent.worktreeId) ? (
              <p className="muted small">
                Latest:{" "}
                {latestFingerprintByWorktree.get(agent.worktreeId)?.semanticSummary}
              </p>
            ) : null}
          </div>
        ))}
        {unjoined.map((worktree) => (
          <div className="row-panel" key={worktree.id}>
            <div className="row-title">
              <span>{worktree.branch ?? worktree.path}</span>
              <span className="risk-medium small">unjoined</span>
            </div>
            <p className="muted small">
              Watcher sees dirty work, but no Codex MCP join is associated yet.
            </p>
          </div>
        ))}
        {snapshot.agents.length === 0 && unjoined.length === 0 ? (
          <div className="row-panel">
            <div className="row-title">
              <span>No active agents</span>
              <span className="muted small">watching</span>
            </div>
            <p className="muted small">
              Joined Codex sessions and dirty unjoined worktrees will appear here.
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}

function checkpointLabel(value: number | null): string {
  if (!value) return "no checkpoint";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s since checkpoint`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m since checkpoint`;
}
