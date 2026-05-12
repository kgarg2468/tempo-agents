import { PageHeader } from "../../../components/page-header";
import { getTempoSnapshot } from "../../../lib/tempo-api";

export default async function InterventionsPage() {
  const snapshot = await getTempoSnapshot();
  const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));

  return (
    <>
      <PageHeader
        title="Interventions"
        subtitle="Brief user-approved directions queued for Codex sessions."
      />
      <div className="panel-list">
        {snapshot.interventions.map((intervention) => (
          <div className="row-panel" key={intervention.id}>
            <div className="row-title">
              <span>
                Direction for {agentNames(intervention.targetAgentSessionIds, agentsById)}
              </span>
              <span className="muted small">{intervention.status}</span>
            </div>
            {intervention.directive ? (
              <div className="intervention-brief">
                <span className="status-pill">{intervention.directive.role}</span>
                {intervention.directive.peerAgentName ? (
                  <span className="muted small">
                    peer: {intervention.directive.peerAgentName}
                  </span>
                ) : null}
              </div>
            ) : null}
            <p className="muted small">{intervention.editedDirection}</p>
          </div>
        ))}
        {snapshot.interventions.length === 0 ? (
          <div className="row-panel">
            <div className="row-title">
              <span>No interventions</span>
              <span className="muted small">idle</span>
            </div>
            <p className="muted small">
              User-approved directions will appear here after a conflict advisory is sent.
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}

function agentNames(
  ids: string[],
  agentsById: Map<string, Awaited<ReturnType<typeof getTempoSnapshot>>["agents"][number]>
): string {
  return ids
    .map((id) => agentsById.get(id)?.displayName ?? id)
    .join(", ");
}
