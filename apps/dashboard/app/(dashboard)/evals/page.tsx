import { PageHeader } from "../../../components/page-header";

export default function EvalsPage() {
  return (
    <>
      <PageHeader
        title="Evals"
        subtitle="Fixture-based recall, false-positive, and latency checks."
      />
      <div className="panel-list">
        <div className="row-panel">
          <div className="row-title">
            <span>Fixture run</span>
            <span className="muted small">ready</span>
          </div>
          <p className="muted small">
            TS/JS, Python, and Java fixtures will run here once fixture storage is
            connected.
          </p>
        </div>
      </div>
    </>
  );
}

