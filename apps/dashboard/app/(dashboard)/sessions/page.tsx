import {
  CheckCircle2,
  CircleDashed,
  GitPullRequestArrow,
  RefreshCcw
} from "lucide-react";
import { PageHeader } from "../../../components/page-header";
import { SessionMap } from "../../../components/session-map";
import { getTempoSnapshot } from "../../../lib/tempo-api";

export default async function SessionsPage() {
  const snapshot = await getTempoSnapshot();
  const activeConflict = snapshot.conflicts.find(
    (conflict) => conflict.status === "open" || conflict.status === "acknowledged"
  );
  const activeDecision = activeConflict
    ? snapshot.decisions.find(
        (decision) =>
          decision.conflictId === activeConflict.id && decision.status === "active"
      )
    : undefined;
  const latestPublication = activeConflict
    ? snapshot.publications.find(
        (publication) => publication.conflictId === activeConflict.id
      )
    : undefined;
  const activeEpisode = activeConflict
    ? snapshot.coordinationEpisodes.find((episode) =>
        episode.conflictIds.includes(activeConflict.id)
      )
    : undefined;
  const activeWorkOrders = activeEpisode
    ? snapshot.workOrders.filter((order) => order.episodeId === activeEpisode.id)
    : [];
  const lifecycle = buildLifecycle(snapshot, activeConflict?.id);
  const integrationActive = snapshot.agents.some(
    (agent) => agent.coordinationRole === "integration"
  );

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle="Live worktree topology, agent activity, and contract convergence."
        action={
          <a className="button" href="/sessions">
            <RefreshCcw size={15} />
            Refresh
          </a>
        }
      />
      {!snapshot.connected && !snapshot.repo ? (
        <section className="surface disconnected-state">
          <span className="status-pill">
            <span className="status-dot status-dot-warn" />
            coordinator unavailable
          </span>
          <div>
            <h2 className="page-title">No live Tempo data</h2>
            <p className="page-subtitle">
              Start `tempo` in a git repo to watch worktrees, agent checkpoints,
              contract decisions, and owner publications.
            </p>
          </div>
        </section>
      ) : null}
      {snapshot.connected || snapshot.repo ? (
      <div className="sessions-grid">
        <div className="sessions-main">
          <section className="surface timeline-panel">
            <div className="row-title">
              <span>Coordination timeline</span>
              <span className="muted small">
                {snapshot.connected ? "live" : "sample data"}
              </span>
            </div>
            <div className="timeline-list">
              {lifecycle.map((item) => (
                <div className={`timeline-item ${item.tone}`} key={item.title}>
                  <div className="timeline-marker">
                    {item.done ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}
                  </div>
                  <div>
                    <p>{item.title}</p>
                    <span className="muted small">{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <SessionMap graph={snapshot.graph} />
        </div>
        <aside className="surface inspector">
          <span className="status-pill">
            <span
              className={`status-dot ${snapshot.connected ? "" : "status-dot-warn"}`}
            />
            {snapshot.connected ? "coordinator online" : "sample data"}
          </span>
          <div>
            <h2 className="page-title">
              {activeConflict?.title ?? "No active conflict"}
            </h2>
            <p className="page-subtitle">
              {activeConflict?.summary ??
                "Tempo is watching for worktrees converging on shared contract surfaces."}
            </p>
          </div>
          <div className="row-panel">
            <div className="row-title">
              <span>Risk</span>
              <span
                className={
                  activeConflict
                    ? activeConflict.risk === "high"
                      ? "risk-high"
                      : "risk-medium"
                    : "risk-clear"
                }
              >
                {activeConflict?.risk ?? "clear"}
              </span>
            </div>
            {activeConflict ? (
              <>
                <p className="muted small">
                  Primary surface: {activeConflict.primarySurface}
                </p>
                {activeConflict.classification ? (
                  <div className="evidence-card">
                    <span className="muted small">
                      {activeConflict.classification.source ?? "classifier"}
                    </span>
                    <p>{activeConflict.classification.rationale}</p>
                  </div>
                ) : null}
                {activeConflict.debate ? (
                  <div className="evidence-card">
                    <span className="muted small">
                      Debate: {activeConflict.debate.verdict}
                    </span>
                    <p>{activeConflict.debate.judge}</p>
                  </div>
                ) : null}
                {activeConflict.tokenCostEstimate ? (
                  <div className="evidence-card">
                    <span className="muted small">Token-cost estimate</span>
                    <p>
                      {activeConflict.tokenCostEstimate.estimatedTokens.toLocaleString()}{" "}
                      tokens
                    </p>
                  </div>
                ) : null}
                {activeDecision ? (
                  <div className="evidence-card">
                    <span className="muted small">Active decision</span>
                    <p>{activeDecision.selectedOptionTitle}</p>
                  </div>
                ) : null}
                {latestPublication ? (
                  <div className="evidence-card">
                    <span className="muted small">
                      Published {latestPublication.surface}
                    </span>
                    <p>{latestPublication.shapeSummary}</p>
                  </div>
                ) : activeDecision?.ownerAgentSessionId ? (
                  <div className="evidence-card">
                    <span className="muted small">Waiting on owner</span>
                    <p>Adapter sessions keep waiting until the owner publishes shape.</p>
                  </div>
                ) : null}
                {activeEpisode ? (
                  <div className="evidence-card">
                    <span className="muted small">Coordination episode</span>
                    <p>
                      {activeEpisode.affectedAgentSessionIds.length} agents ·{" "}
                      {activeWorkOrders.length} work orders · {activeEpisode.status}
                    </p>
                  </div>
                ) : null}
                {activeWorkOrders.length > 0 ? (
                  <div className="evidence-grid evidence-grid-compact">
                    {activeWorkOrders.slice(0, 3).map((order) => (
                      <div className="evidence-card" key={order.id}>
                        <span className="muted small">
                          {order.role.replace("_", " ")} · {order.status}
                        </span>
                        <p>{order.summary}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="evidence-grid evidence-grid-compact">
                  {activeConflict.riskReasons.slice(0, 2).map((reason) => (
                    <div
                      className="evidence-card"
                      key={`${activeConflict.id}-${reason.label}`}
                    >
                      <span className="muted small">{reason.label}</span>
                      <p>{reason.detail}</p>
                    </div>
                  ))}
                </div>
                <details className="raw-details">
                  <summary>Raw evidence</summary>
                  <p className="muted small">
                    {activeConflict.evidence.join("; ")}.
                  </p>
                  <p className="muted small">
                    Grouped surfaces: {activeConflict.affectedSurfaces.join(", ")}.
                  </p>
                </details>
              </>
            ) : (
              <p className="muted small">
                {snapshot.worktrees.length} worktrees,{" "}
                {snapshot.fingerprints.length} active fingerprints.
                {integrationActive ? " Integration session active." : ""}
              </p>
            )}
          </div>
          {activeConflict ? (
            <a className="button" href="/conflicts">
              <GitPullRequestArrow size={15} />
              Open conflict
            </a>
          ) : (
            <span aria-disabled="true" className="button button-disabled">
              <GitPullRequestArrow size={15} />
              No conflict
            </span>
          )}
        </aside>
      </div>
      ) : null}
    </>
  );
}

type Snapshot = Awaited<ReturnType<typeof getTempoSnapshot>>;
type TimelineItem = {
  title: string;
  detail: string;
  done: boolean;
  tone: "done" | "active" | "waiting" | "muted";
};

function buildLifecycle(snapshot: Snapshot, conflictId: string | undefined): TimelineItem[] {
  const activeConflict = conflictId
    ? snapshot.conflicts.find((conflict) => conflict.id === conflictId)
    : undefined;
  const activeDecision = conflictId
    ? snapshot.decisions.find(
        (decision) => decision.conflictId === conflictId && decision.status === "active"
      )
    : undefined;
  const publication = conflictId
    ? snapshot.publications.find((item) => item.conflictId === conflictId)
    : undefined;
  const relatedInterventions = conflictId
    ? snapshot.interventions.filter((item) => item.conflictId === conflictId)
    : [];
  const relatedEpisode = conflictId
    ? snapshot.coordinationEpisodes.find((episode) =>
        episode.conflictIds.includes(conflictId)
      )
    : undefined;
  const relatedWorkOrders = relatedEpisode
    ? snapshot.workOrders.filter((order) => order.episodeId === relatedEpisode.id)
    : [];
  const adapterResume = relatedInterventions.find(
    (item) =>
      item.directive?.role === "adapter" &&
      publication &&
      item.editedDirection.includes(publication.shapeSummary)
  );
  const allClean =
    snapshot.worktrees.length > 0 && snapshot.worktrees.every((worktree) => !worktree.dirty);
  const hasCoordinationActivity =
    snapshot.agents.length > 0 ||
    snapshot.conflicts.length > 0 ||
    snapshot.decisions.length > 0 ||
    snapshot.publications.length > 0 ||
    snapshot.interventions.length > 0;
  const integrationActive = snapshot.agents.some(
    (agent) => agent.coordinationRole === "integration"
  );
  const readyForIntegration = hasCoordinationActivity && allClean && !activeConflict;

  return [
    {
      title: snapshot.connected ? "Coordinator online" : "Coordinator unavailable",
      detail: snapshot.connected
        ? `${snapshot.coordinatorUrl} is serving live repo state.`
        : "No sample conflicts are shown unless sample-data mode is enabled.",
      done: snapshot.connected,
      tone: snapshot.connected ? "done" : "waiting"
    },
    {
      title: `${snapshot.agents.length} agent session${snapshot.agents.length === 1 ? "" : "s"}`,
      detail:
        snapshot.agents.length > 0
          ? snapshot.agents.map((agent) => agent.displayName).join(", ")
          : "Agents appear after tempo_join.",
      done: snapshot.agents.length > 0,
      tone: snapshot.agents.length > 0 ? "done" : "muted"
    },
    {
      title: activeConflict ? activeConflict.title : "No blocking conflict",
      detail: activeConflict
        ? activeConflict.summary
        : "Tempo is watching for contract convergence.",
      done: Boolean(activeConflict),
      tone: activeConflict
        ? activeConflict.classification?.kind === "coordination_notice"
          ? "done"
          : "active"
        : "muted"
    },
    {
      title: activeConflict?.classification
        ? `Classifier: ${activeConflict.classification.kind}`
        : "Classifier evidence",
      detail: activeConflict?.classification
        ? `${activeConflict.classification.source ?? "model"} · ${
            activeConflict.classification.rationale
          }`
        : "OpenAI or deterministic fallback verdicts show here.",
      done: Boolean(activeConflict?.classification),
      tone: activeConflict?.classification ? "done" : "muted"
    },
    {
      title: relatedEpisode
        ? `Episode: ${relatedEpisode.affectedAgentSessionIds.length} agents`
        : "Coordination episode",
      detail: relatedEpisode
        ? `${relatedEpisode.surface} · ${relatedWorkOrders.length} active work orders`
        : "Shared-surface collisions become one owner/adapters episode.",
      done: Boolean(relatedEpisode),
      tone: relatedEpisode ? "done" : activeConflict ? "waiting" : "muted"
    },
    {
      title: activeDecision
        ? `Decision: ${activeDecision.selectedOptionTitle}`
        : "Decision pending",
      detail: activeDecision
        ? activeDecision.selectedOptionDirection
        : "Blocking conflicts wait for a user-approved direction.",
      done: Boolean(activeDecision),
      tone: activeDecision ? "done" : activeConflict ? "waiting" : "muted"
    },
    {
      title: publication ? `Published ${publication.surface}` : "Owner publication",
      detail: publication
        ? publication.shapeSummary
        : activeDecision?.ownerAgentSessionId
          ? "Adapters continue waiting until the owner checkpoint publishes the shape."
          : "Split ownership creates an owner publication checkpoint.",
      done: Boolean(publication),
      tone: publication ? "done" : activeDecision ? "waiting" : "muted"
    },
    {
      title: adapterResume ? "Adapter resume direction queued" : "Adapter resume",
      detail: adapterResume
        ? `${adapterResume.status}: ${adapterResume.editedDirection}`
        : publication
          ? "Publication will wake adapter sessions through wait/checkpoint."
          : "Adapters pause disputed edits until publication arrives.",
      done: Boolean(adapterResume),
      tone: adapterResume ? "done" : publication ? "active" : "muted"
    },
    {
      title: integrationActive && !allClean
        ? "Integration in progress"
        : readyForIntegration
        ? "Ready for integration prompt"
        : hasCoordinationActivity
          ? "Worktrees not clean yet"
          : "Waiting for agent sessions",
      detail: integrationActive && !allClean
        ? "An integration session is converging feature work into main without opening new blocking choices."
        : readyForIntegration
        ? "Tempo coordination is complete; use a normal agent prompt for merging."
        : hasCoordinationActivity
          ? "Dirty worktrees still need commits or integration-agent handling."
          : "Launch feature agents to begin the coordination flow.",
      done: readyForIntegration,
      tone: integrationActive && !allClean
        ? "active"
        : readyForIntegration
          ? "done"
          : hasCoordinationActivity
            ? "waiting"
            : "muted"
    }
  ];
}
