import { PageHeader } from "../../../components/page-header";
import { getTempoSnapshot } from "../../../lib/tempo-api";

export default async function SettingsPage() {
  const snapshot = await getTempoSnapshot();
  const { settings } = snapshot;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Local coordinator health, Codex MCP setup, and repo configuration."
      />
      <div className="panel-list">
        <div className="row-panel">
          <div className="row-title">
            <span>Coordinator</span>
            <span className={snapshot.connected ? "small" : "risk-medium small"}>
              {snapshot.connected ? "online" : "unavailable"}
            </span>
          </div>
          <p className="muted small">{snapshot.coordinatorUrl}</p>
        </div>
        <div className="row-panel">
          <div className="row-title">
            <span>OpenAI</span>
            <span className={settings.openai.configured ? "small" : "risk-medium small"}>
              {settings.openai.configured ? "configured" : "missing key"}
            </span>
          </div>
          <p className="muted small">Model: {settings.openai.model}</p>
        </div>
        <div className="row-panel">
          <div className="row-title">
            <span>Codex MCP</span>
            <span className="muted small">setup command available</span>
          </div>
          <p className="muted small">
            codex mcp add tempo --url {settings.codex.mcpUrl}
          </p>
        </div>
      </div>
    </>
  );
}
