import { PageHeader } from "../../../components/page-header";
import {
  generateAdvisory,
  recordDecision,
  updateConflictStatus
} from "../../../lib/actions";
import { getTempoSnapshot } from "../../../lib/tempo-api";

export default async function ConflictsPage() {
  const snapshot = await getTempoSnapshot();
  const agentsByWorktree = new Map(
    snapshot.agents.flatMap((agent) =>
      agent.worktreeId ? [[agent.worktreeId, agent.id] as const] : []
    )
  );
  const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const agentsByWorktreeId = new Map(
    snapshot.agents.flatMap((agent) =>
      agent.worktreeId ? [[agent.worktreeId, agent] as const] : []
    )
  );

  return (
    <>
      <PageHeader
        title="Conflicts"
        subtitle="Open, acknowledged, resolved, and ignored coordination risks."
      />
      <div className="panel-list">
        {snapshot.conflicts.map((conflict) => {
          const activeDecision = snapshot.decisions.find(
            (decision) =>
              decision.conflictId === conflict.id && decision.status === "active"
          );
          const deliveries = snapshot.interventions.filter(
            (intervention) => intervention.conflictId === conflict.id
          );
          const publication = snapshot.publications.find(
            (item) => item.conflictId === conflict.id
          );
          const conflictEpisodes = snapshot.coordinationEpisodes.filter((episode) =>
            episode.conflictIds.includes(conflict.id)
          );
          const conflictEpisodeIds = new Set(conflictEpisodes.map((episode) => episode.id));
          const mergeRisks = snapshot.mergeRisks.filter((risk) =>
            conflictEpisodeIds.has(risk.episodeId)
          );
          return (
            <div className="row-panel" key={conflict.id}>
            <div className="row-title">
              <span>{conflict.title}</span>
              <span
                className={`${riskClass(conflict)} small`}
              >
                {labelForConflict(conflict)} · {conflict.confidence.toFixed(2)} ·{" "}
                {conflict.status}
              </span>
            </div>
            <div className="action-summary">
              <p>{conflict.summary}</p>
              <span className="status-pill">Primary: {conflict.primarySurface}</span>
              {conflict.classification?.rationale ? (
                <span className="status-pill">
                  {conflict.classification.source ?? "classifier"}:{" "}
                  {conflict.classification.kind}
                </span>
              ) : null}
            </div>
            {conflict.classification?.rationale ? (
              <p className="muted small">{conflict.classification.rationale}</p>
            ) : null}
            {conflict.debate ? (
              <div className="evidence-card">
                <span className="muted small">
                  Debate verdict: {conflict.debate.verdict}
                </span>
                <p>{conflict.debate.judge}</p>
              </div>
            ) : null}
            {conflict.tokenCostEstimate ? (
              <div className="agent-meta">
                <span className="status-pill">
                  estimated {conflict.tokenCostEstimate.estimatedTokens.toLocaleString()}{" "}
                  tokens
                </span>
                <span className="status-pill">
                  files {conflict.tokenCostEstimate.inputs.filesTouched}
                </span>
                <span className="status-pill">
                  surfaces {conflict.tokenCostEstimate.inputs.touchedSurfaces}
                </span>
              </div>
            ) : null}
            {mergeRisks.length > 0 ? (
              <div className="evidence-grid">
                {mergeRisks.map((risk) => (
                  <div className="evidence-card" key={risk.id}>
                    <span className={`${risk.safe ? "risk-clear" : "risk-high"} small`}>
                      merge-risk {risk.status} · {risk.risk}
                    </span>
                    {risk.predictedConflicts.slice(0, 2).map((item) => (
                      <p key={item.id}>{item.summary}</p>
                    ))}
                    <div className="agent-meta">
                      {risk.rocketRideRunId ? (
                        <span className="status-pill">
                          RocketRide {risk.rocketRideRunId}
                        </span>
                      ) : null}
                      {risk.requiredWorkOrders.slice(0, 2).map((workOrderId) => (
                        <span className="status-pill" key={workOrderId}>
                          blocks {workOrderId}
                        </span>
                      ))}
                    </div>
                    {risk.evidence.slice(0, 2).map((item) => (
                      <p className="muted small" key={`${risk.id}-${item.label}`}>
                        {item.label}: {item.detail}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="agent-meta">
              {conflict.affectedWorktreeIds.map((worktreeId) => {
                const agent = agentsByWorktreeId.get(worktreeId);
                return (
                  <span className="status-pill" key={worktreeId}>
                    {agent ? agent.displayName : `unreachable ${worktreeId.slice(0, 7)}`}
                  </span>
                );
              })}
            </div>
            <div className="evidence-grid">
              {conflict.riskReasons.slice(0, 3).map((reason) => (
                <div className="evidence-card" key={`${conflict.id}-${reason.label}`}>
                  <span className="muted small">{reason.label}</span>
                  <p>{reason.detail}</p>
                </div>
              ))}
            </div>
            {snapshot.decisions
              .filter((decision) => decision.conflictId === conflict.id)
              .map((decision) => (
                <div className="decision-timeline" key={decision.id}>
                  <span className="muted small">
                    {decision.status === "active" ? "Active decision" : "Decision"}
                  </span>
                  <p>{decision.selectedOptionTitle}</p>
                  <div className="agent-meta">
                    <span className="status-pill">{decision.createdBy}</span>
                    <span className="status-pill">{decision.status}</span>
                    {conflict.affectedWorktreeIds.map((worktreeId) => (
                      <span className="status-pill" key={`${decision.id}-${worktreeId}`}>
                        {deliveryStatusForWorktree(
                          worktreeId,
                          agentsByWorktreeId,
                          deliveries
                        )}
                      </span>
                    ))}
                  </div>
                  {publication ? (
                    <div className="publication-callout">
                      <span className="muted small">
                        Published {publication.surface}
                      </span>
                      <p>{publication.shapeSummary}</p>
                      {publication.files.length > 0 ? (
                        <span className="muted small">
                          {publication.files.join(", ")}
                        </span>
                      ) : null}
                    </div>
                  ) : decision.ownerAgentSessionId ? (
                    <div className="publication-callout publication-waiting">
                      <span className="muted small">Waiting on owner publication</span>
                      <p>
                        Adapter sessions should keep waiting until the owner checkpoint
                        publishes the final contract shape.
                      </p>
                    </div>
                  ) : null}
                </div>
              ))}
            <details className="raw-details">
              <summary>Raw evidence</summary>
              <p className="muted small">{conflict.evidence.join("; ")}.</p>
            </details>
            <div className="button-row">
              {["acknowledged", "ignored", "resolved"].map((status) => (
                <form action={updateConflictStatus} key={status}>
                  <input name="id" type="hidden" value={conflict.id} />
                  <input name="status" type="hidden" value={status} />
                  <button className="button button-small" type="submit">
                    {status}
                  </button>
                </form>
              ))}
              <form action={generateAdvisory}>
                <input name="id" type="hidden" value={conflict.id} />
                <button className="button button-small" type="submit">
                  Generate advisory
                </button>
              </form>
            </div>
            {activeDecision ? (
              <div className="decision-timeline">
                <span className="muted small">Choices closed</span>
                <p>
                  Tempo will deliver queued directions for this decision through
                  checkpoint or wait calls.
                </p>
              </div>
            ) : snapshot.advisories
              .filter((advisory) => advisory.conflictId === conflict.id)
              .flatMap((advisory) => advisory.options)
              .map((option) => {
                const splitOwnership = option.title === "Split ownership";
                const targetAgentSessionIds = conflict.affectedWorktreeIds
                  .map((worktreeId) => agentsByWorktree.get(worktreeId))
                  .filter((id): id is string => Boolean(id));
                const targetAgents = targetAgentSessionIds.flatMap((id) => {
                  const agent = agentsById.get(id);
                  return agent ? [agent] : [];
                });
                const recommendedOwner = conflict.classification?.recommendedOwnerWorktreeId
                  ? agentsByWorktreeId.get(
                      conflict.classification.recommendedOwnerWorktreeId
                    )
                  : targetAgents[0];
                return (
                  <form action={recordDecision} className="advisory-form" key={option.id}>
                    <input name="conflictId" type="hidden" value={conflict.id} />
                    <input name="selectedOptionId" type="hidden" value={option.id} />
                    <input name="selectedOptionTitle" type="hidden" value={option.title} />
                    <label className="muted small" htmlFor={`direction-${option.id}`}>
                      {option.title}
                      {conflict.classification?.recommendedOptionId === option.id
                        ? " · recommended"
                        : ""}
                    </label>
                    <p className="muted small">{option.rationale}</p>
                    {splitOwnership ? (
                      <p className="muted small">
                        Tempo sends complementary owner and adapter plans. Recommended
                        owner: {recommendedOwner?.displayName ?? "choose one"}.
                      </p>
                    ) : null}
                    <textarea
                      defaultValue={option.direction}
                      id={`direction-${option.id}`}
                      name="selectedOptionDirection"
                      rows={3}
                    />
                    <div className="button-row">
                      {!splitOwnership ? (
                        <button
                          className="button button-small"
                          disabled={targetAgentSessionIds.length === 0}
                          type="submit"
                        >
                          Choose this direction
                        </button>
                      ) : null}
                      {splitOwnership
                        ? targetAgents.map((agent) => (
                            <button
                              className="button button-small"
                              key={`${option.id}-owner-${agent.id}`}
                              name="ownerAgentSessionId"
                              type="submit"
                              value={agent.id}
                            >
                              Make {agent.displayName} owner
                            </button>
                          ))
                        : null}
                      {targetAgentSessionIds.length === 0 ? (
                        <span className="muted small">
                          No joined agent sessions are attached to these worktrees.
                        </span>
                      ) : null}
                    </div>
                  </form>
                );
              })}
            </div>
          );
        })}
        {snapshot.conflicts.length === 0 ? (
          <div className="row-panel">
            <div className="row-title">
              <span>No conflicts</span>
              <span className="muted small">clear</span>
            </div>
            <p className="muted small">
              Medium and high contract risks will appear here with evidence.
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}

function labelForConflict(conflict: Awaited<ReturnType<typeof getTempoSnapshot>>["conflicts"][number]) {
  if (conflict.classification?.kind === "coordination_notice") {
    return "coordination notice";
  }
  return `${conflict.risk} risk`;
}

function riskClass(conflict: Awaited<ReturnType<typeof getTempoSnapshot>>["conflicts"][number]) {
  if (conflict.classification?.kind === "coordination_notice") return "risk-notice";
  return conflict.risk === "high" ? "risk-high" : "risk-medium";
}

function deliveryStatusForWorktree(
  worktreeId: string,
  agentsByWorktreeId: Map<
    string,
    Awaited<ReturnType<typeof getTempoSnapshot>>["agents"][number]
  >,
  deliveries: Awaited<ReturnType<typeof getTempoSnapshot>>["interventions"]
): string {
  const agent = agentsByWorktreeId.get(worktreeId);
  if (!agent) return `unreachable ${worktreeId.slice(0, 7)}: no joined agent`;
  const delivery = deliveries.find((intervention) =>
    intervention.targetAgentSessionIds.includes(agent.id)
  );
  return `${agent.displayName}: ${delivery?.status ?? "not queued"}`;
}
