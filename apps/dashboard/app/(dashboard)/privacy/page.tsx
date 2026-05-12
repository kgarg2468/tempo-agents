import { PageHeader } from "../../../components/page-header";
import { getTempoSnapshot } from "../../../lib/tempo-api";

export default async function PrivacyPage() {
  const snapshot = await getTempoSnapshot();

  return (
    <>
      <PageHeader
        title="Privacy"
        subtitle="Local evidence retention, redactions, and cloud escalation packets."
      />
      <div className="privacy-grid">
        <section className="surface privacy-section">
          <div className="row-title">
            <span>Local evidence</span>
            <span className="muted small">
              {snapshot.evidencePackets.length} packet
              {snapshot.evidencePackets.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="panel-list">
            {snapshot.evidencePackets.length === 0 ? (
              <div className="row-panel">
                <p className="muted small">No hook or MCP evidence recorded.</p>
              </div>
            ) : null}
            {snapshot.evidencePackets.map((packet) => (
              <div className="row-panel" key={packet.id}>
                <div className="row-title">
                  <span>{packet.sessionId}</span>
                  <span className="small">
                    {packet.privacy.retentionDays}d retention
                  </span>
                </div>
                <div className="agent-meta">
                  <span className="status-pill">source: {packet.source}</span>
                  <span className="status-pill">
                    expires: {formatTime(packet.expiresAt)}
                  </span>
                  <span className="status-pill">
                    hooks: {packet.hookEvents.length}
                  </span>
                  <span className="status-pill">
                    files: {packet.git.stats.filesChanged}
                  </span>
                </div>
                {packet.promptSummary ? (
                  <p className="muted small">{packet.promptSummary}</p>
                ) : null}
                <details className="raw-details">
                  <summary>Evidence summary</summary>
                  <pre className="code-block">
                    {JSON.stringify(
                      {
                        git: packet.git,
                        surfaces: packet.surfaces.map((surface) => surface.label),
                        decisionHistory: packet.decisionHistory,
                        redactions: packet.privacy.redactions
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        </section>
        <section className="surface privacy-section">
          <div className="row-title">
            <span>Cloud escalations</span>
            <span className="muted small">
              {snapshot.cloudEscalationPackets.length} packet
              {snapshot.cloudEscalationPackets.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="panel-list">
            {snapshot.cloudEscalationPackets.length === 0 ? (
              <div className="row-panel">
                <p className="muted small">No cloud escalation packets assembled.</p>
              </div>
            ) : null}
            {snapshot.cloudEscalationPackets.map((packet) => (
              <div className="row-panel" key={packet.id}>
                <div className="row-title">
                  <span>{packet.reason}</span>
                  <span className="small">{packet.status}</span>
                </div>
                <div className="agent-meta">
                  <span className="status-pill">provider: {packet.provider}</span>
                  <span className="status-pill">
                    created: {formatTime(packet.createdAt)}
                  </span>
                  {packet.sentAt ? (
                    <span className="status-pill">
                      sent: {formatTime(packet.sentAt)}
                    </span>
                  ) : null}
                  <span className="status-pill">
                    redactions: {packet.redactions.length}
                  </span>
                </div>
                {packet.redactions.length > 0 ? (
                  <p className="muted small">{packet.redactions.join(", ")}</p>
                ) : null}
                <details className="raw-details">
                  <summary>Sent context</summary>
                  <pre className="code-block">
                    {JSON.stringify(packet.redactedContext, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
