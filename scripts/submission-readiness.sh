#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/test-artifacts/submission-$RUN_ID}"
TEMPO_URL="${TEMPO_URL:-http://127.0.0.1:3747}"
ROCKETRIDE_URI="${ROCKETRIDE_URI:-http://127.0.0.1:5565}"

mkdir -p "$EVIDENCE_DIR"/{logs,snapshots,oracle}

cd "$ROOT"

git status --short --branch | tee "$EVIDENCE_DIR/logs/tempo-git-status.txt"
pnpm typecheck | tee "$EVIDENCE_DIR/logs/typecheck.txt"
pnpm test | tee "$EVIDENCE_DIR/logs/test.txt"
pnpm lint | tee "$EVIDENCE_DIR/logs/lint.txt"
pnpm build | tee "$EVIDENCE_DIR/logs/build.txt"
git diff --check | tee "$EVIDENCE_DIR/logs/diff-check.txt"

curl -sS -i "$ROCKETRIDE_URI/health" \
  > "$EVIDENCE_DIR/snapshots/rocketride-health.txt" || true

for endpoint in \
  health \
  api/settings \
  api/agents \
  api/worktrees \
  api/conflicts \
  api/coordination-episodes \
  api/work-orders \
  api/merge-risks \
  api/decisions
do
  curl -sS "$TEMPO_URL/$endpoint" \
    > "$EVIDENCE_DIR/snapshots/${endpoint//\//-}.json" || true
done

cat > "$EVIDENCE_DIR/README.md" <<EOF
# Tempo Submission Evidence

Run ID: \`$RUN_ID\`

This bundle contains local gate logs plus best-effort RocketRide/Tempo API
snapshots. A submission-ready run still requires the live three-agent todo
scenario to converge to safe/coordinated and the disposable external Git oracle
to pass after Tempo convergence.
EOF

echo "Evidence directory: $EVIDENCE_DIR"
