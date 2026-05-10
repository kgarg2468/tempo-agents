# Rebase Full Project Build Plan

## Summary

Build Rebase as a local-first coordination tool for parallel AI coding sessions. The target user runs `rebase` from any git repo, Rebase watches all worktrees, Codex sessions join through MCP, live diffs are fingerprinted, contract-surface conflicts are detected while agents are coding, and the dashboard lets the user send brief advisory direction back to Codex.

Core principles:

- Watcher-based live diff detection is authoritative.
- MCP is the in-agent UX, not the only detection path.
- Rebase is advisory and human-controlled.
- V1 is Codex-first, local-first, and open-source-ready.
- The standalone todo app is an external target repo used for demos/evals, not embedded in Rebase.

## Current Implementation Status

- Phase 0 foundation is implemented: pnpm monorepo, TypeScript, lint/test/build scripts, shared Zod schemas, README/license/env/gitignore.
- Phase 1 is partly implemented: `rebase` prepares repo-local runtime state, prompts before `.gitignore`/`AGENTS.md` edits, starts the coordinator, and launches the dashboard in workspace installs.
- Phase 2 is partly implemented: Fastify coordinator, local SQLite store, token-protected mutations, health/settings/repo/worktree/event APIs, JSONL exports, and WebSocket event stream exist.
- Phase 3 is partly implemented: worktree discovery, ignored-path watcher, debounce scan, periodic refresh, diff hashing, analysis persistence, and conflict auto-resolution exist.
- Phase 4 is partly implemented: all core tables exist and repo/worktree/session/fingerprint/conflict/advisory/intervention/event persistence is covered; raw diffs are not stored.
- Phase 5 is partly implemented: AST-lite heuristics cover generic paths plus TS/JS, Python, and Java-like surfaces.
- Phase 6 is partly implemented: OpenAI fingerprint enrichment is implemented with bounded payloads, structured validation, cache-by-diff-hash model output, and heuristic degraded mode.
- Phase 7 is partly implemented: active fingerprints are compared for shared contract surfaces/files/symbols and medium conflicts open/update/resolve.
- Phase 8 is partly implemented: heuristic advisory options and queued edited interventions are persisted and fetchable by MCP.
- Phase 9 is partly implemented: MCP tools exist for join, plan, checkpoint, and fetch intervention.
- Phase 10-12 are partly implemented: dashboard shell, live refresh, Sessions graph, Agents, Conflicts, Interventions, Evals, and Settings pages exist and read coordinator data with demo fallback.
- Phase 13 is partly implemented: fixture eval runner and metrics exist.
- Phase 14-15 remain pending.

## Phase 0: Project Foundation

Goal: turn the empty Rebase folder into a maintainable monorepo foundation.

Build:

- Initialize git repo, pnpm workspace, TypeScript config, lint/test tooling, MIT license, README, `.gitignore`, `.env.example`.
- Create workspace layout:
  - `apps/dashboard`
  - `packages/cli`
  - `packages/coordinator`
  - `packages/shared`
  - `packages/evals`
- Add root scripts:
  - `pnpm dev`
  - `pnpm test`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
- Use Node + pnpm only. No Bun runtime dependency.
- Add shared Zod schemas for core objects: repo, worktree, agent session, fingerprint, conflict, advisory, intervention.

E2E / ship gate:

- Fresh clone runs `pnpm install`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` pass.
- README explains current dev workflow and target `rebase` UX.
- No runtime feature is considered built yet; this phase ships only when the repo is clean and reproducible.

## Phase 1: Thin CLI And Local Runtime Boot

Goal: make `rebase` the real entrypoint without putting product logic inside the CLI.

Build:

- Implement CLI binary `rebase` in `packages/cli`.
- When run inside a git repo:
  - detect git root
  - create `.rebase/`
  - create/read `.rebase/runtime.json`
  - choose coordinator port `3747`
  - start coordinator process
  - start/open dashboard
- If not inside a git repo, fail with a clear message.
- First run should offer, with prompts:
  - add `.rebase/` to `.gitignore`
  - add marked Rebase block to `AGENTS.md`
  - detect Codex MCP config and offer exact setup command
- Do not create `rebase.config.ts` unless user customizes settings later.
- Use stable localhost URLs:
  - coordinator: `http://127.0.0.1:3747`
  - MCP: `http://127.0.0.1:3747/mcp`

E2E / ship gate:

- In a temp git repo, running `rebase` creates `.rebase/` and starts the coordinator.
- In a non-git folder, running `rebase` exits cleanly with helpful text.
- First-run prompts never modify `AGENTS.md` or `.gitignore` without confirmation.
- Running `rebase` twice reuses existing runtime state instead of duplicating setup.
- Dashboard opens automatically or prints a fallback URL if browser open fails.

## Phase 2: Coordinator Spine

Goal: build the long-running local service that all other systems attach to.

Build:

- Fastify coordinator owns:
  - health API
  - repo/worktree API
  - WebSocket event stream
  - local token validation
  - SQLite/Drizzle connection
  - runtime logs
- Store local DB under `.rebase/rebase.sqlite`.
- Store generated token under `.rebase/runtime.json`.
- Bind to `127.0.0.1`.
- Add `/health`, `/api/repo`, `/api/worktrees`, `/api/events`, `/api/settings`.
- Dashboard and MCP mutation calls must include local token.
- Do not store raw diffs by default.

E2E / ship gate:

- Starting coordinator from a temp repo creates SQLite schema.
- Health endpoint reports repo root, git status availability, DB availability, and token status.
- WebSocket clients receive startup and repo-state events.
- Killing/restarting coordinator preserves repo/worktree/session history.
- Invalid/missing token cannot mutate state.

## Phase 3: Git Worktree Discovery And Watcher

Goal: Rebase passively sees live work across all worktrees.

Build:

- Discover worktrees via `git worktree list --porcelain`.
- Track:
  - worktree path
  - branch
  - HEAD SHA
  - dirty state
  - last observed diff hash
- Watch all discovered worktrees with ignored paths:
  - `.git`
  - `.rebase`
  - `node_modules`
  - build/cache dirs
  - configurable ignores later
- Debounce changed worktrees.
- On debounce:
  - run `git diff --no-ext-diff`
  - normalize hunks
  - hash scoped diff
  - emit worktree activity event
- Poll worktree list periodically so Codex-created worktrees appear automatically.
- Same-worktree multi-agent use is not optimized in v1; show degraded attribution if detected.

E2E / ship gate:

- Temp repo with two git worktrees is detected correctly.
- Editing a file in worktree A emits activity for A only.
- Editing a file in worktree B emits activity for B only.
- Creating a new worktree while Rebase is running adds it without restart.
- Ignored paths do not trigger analysis.
- Diff hash is stable for identical hunks and changes when relevant content changes.

## Phase 4: SQLite Domain Model

Goal: persist enough state for dashboard, evals, and debugging without storing raw code.

Build tables for:

- repos
- worktrees
- agent_sessions
- fingerprints
- conflicts
- advisories
- interventions
- events
- eval_runs
- eval_cases
- settings

Persist:

- fingerprint metadata
- changed files
- detected symbols/surfaces
- semantic summary
- risk verdicts
- confidence/evidence
- conflict lifecycle state
- advisory text and edited user text
- intervention delivery/fetch/ack timestamps

Do not persist raw diff hunks by default.

E2E / ship gate:

- Coordinator can restart and restore all active conflicts/interventions.
- A worktree edit creates event and fingerprint records once analysis is added.
- Conflict lifecycle transitions persist.
- Export endpoint returns JSONL/CSV for events, conflicts, and evals.
- DB migrations run from empty DB and from previous phase DB.

## Phase 5: AST-Lite Polyglot Local Index

Goal: create local grounding that works across arbitrary repos without building a full code graph product.

Build:

- Generic indexer:
  - git-tracked files
  - path classification
  - extension classification
  - route/schema/model/controller/component/test/migration heuristics
- TS/JS extractor:
  - imports/exports
  - interfaces/types
  - functions/classes
  - React component prop-like types
  - route-like files
- Python extractor:
  - classes/functions
  - Pydantic model-looking classes
  - FastAPI/Django route/model/controller-looking files
- Java extractor:
  - classes/interfaces
  - controllers/services/repositories/entities/DTO-looking names/annotations
- Surface grouping:
  - contract surfaces like `Task model`, `/api/tasks`, `Task DTO`, `TaskCard props`
  - surfaces are best-effort with confidence and evidence
- Re-index incrementally after file changes.

E2E / ship gate:

- Fixture repos for TS/JS, Python, Java produce expected surfaces.
- Editing schema/model files updates surfaces incrementally.
- Unknown language repos still produce generic file/path surfaces.
- Indexing a medium repo does not block watcher responsiveness.
- Surface extraction failures are logged and do not crash coordinator.

## Phase 6: OpenAI Fingerprint Pipeline

Goal: convert live diffs into structured intent with bounded payloads.

Build:

- Read `OPENAI_API_KEY` and optional `OPENAI_MODEL`, default `gpt-5.4-mini`.
- Stage 1 model call:
  - input: scoped hunks, changed files, local surfaces, small relevant context
  - output: structured fingerprint
- Fingerprint shape:
  - worktree id
  - files touched
  - symbols added/modified/removed
  - surfaces touched
  - semantic summary
  - likely contract changes
  - confidence
- Cache by normalized diff hash.
- If OpenAI is missing/slow/fails:
  - show degraded analysis state
  - do not fake cached advisory output
  - keep watcher and heuristic metadata working

E2E / ship gate:

- Mock OpenAI returns valid fingerprint and persists it.
- Invalid model output is rejected and logged.
- Missing API key shows degraded mode in Settings and does not crash.
- Same diff reuses cached fingerprint.
- Changed diff triggers a new fingerprint.
- Fingerprint latency is measured and shown in events.

## Phase 7: Conflict Detection Engine

Goal: detect live contract conflicts while agents are coding, before commit/merge.

Build:

- Compare active fingerprints across worktrees.
- Risk inputs:
  - same/related contract surfaces
  - same files
  - same symbols
  - schema/API/shared-type/component-prop changes
  - timing overlap
  - model semantic similarity
- Risk output:
  - low/medium/high
  - confidence
  - evidence
  - affected worktrees
  - affected surfaces
  - conflict type
- Open medium/high conflicts automatically.
- Low risks log as events but do not interrupt UX.
- Medium/high risks ask agents to pause on next MCP checkpoint.
- Target normal alert latency: 2-5 seconds after edits settle.
- Mark over 10 seconds as degraded.

E2E / ship gate:

- Two worktrees editing unrelated files do not create medium/high conflict.
- Two worktrees editing same schema surface create conflict before commit.
- API/schema mismatch fixture creates conflict.
- UI prop/shared type mismatch fixture creates conflict.
- Conflict evidence points to specific surfaces/files.
- Existing conflict updates instead of duplicating on every save.
- Conflict resolves when later fingerprints no longer overlap.

## Phase 8: Advisory And Intervention Flow

Goal: give useful direction without pretending Rebase is the main coding brain.

Build:

- Stage 2 OpenAI call only for medium/high conflicts.
- Generate advisory options:
  - 2-3 brief countermeasures
  - each includes rationale, affected surfaces, and expected agent behavior
- User can:
  - acknowledge conflict
  - ignore conflict
  - mark resolved
  - choose advisory option
  - edit final brief direction
  - send intervention
- Sent intervention is queued for relevant agent sessions.
- Direction sent to Codex should be concise:
  - conflict reason
  - evidence
  - chosen countermeasure
  - affected files/surfaces
  - instruction to revise its own plan
- Auto-resolution is evidence-based: close when later fingerprints show risky overlap is gone.

E2E / ship gate:

- Medium/high conflict produces advisory options.
- User edit is preserved separately from model draft.
- Sending intervention queues it for relevant sessions.
- Ignored conflict stops prompting but remains in history.
- Resolved conflict disappears from active queue.
- If advisory generation fails, conflict still opens with evidence and degraded advisory state.

## Phase 9: Codex MCP Integration

Goal: make Rebase visible inside Codex without relying on Codex for core detection.

Build MCP tools:

- `rebase_join`
- `rebase_plan`
- `rebase_checkpoint`
- `rebase_fetch_intervention`

Behavior:

- `join` maps Codex session to cwd/worktree.
- `plan` records intended work before edits.
- `checkpoint` returns current unread Rebase notifications, risk status, and pause guidance.
- `fetch_intervention` returns approved user direction.
- If no MCP join exists but watcher sees changes, show worktree as “unjoined active worktree.”
- `AGENTS.md` Rebase block requires:
  - join at session start
  - plan before meaningful edits
  - checkpoint after meaningful edit batches
  - checkpoint before commit
  - report Rebase notifications in Codex TUI
  - pause on medium/high risk

E2E / ship gate:

- Codex MCP config can connect to local Rebase MCP endpoint.
- Simulated MCP client can join, plan, checkpoint, fetch intervention.
- Joined worktree is labeled Codex in dashboard.
- Unjoined changed worktree is still detected and flagged.
- Medium/high conflict appears in `rebase_checkpoint` response.
- Intervention fetch marks intervention as fetched.

## Phase 10: Dashboard App Shell

Goal: create the polished operator console.

Build:

- Next.js + shadcn dashboard.
- Dark operator-console visual system.
- Navigation pages:
  - Sessions
  - Agents
  - Conflicts
  - Interventions
  - Evals
  - Settings
- WebSocket client for live coordinator events.
- Shared API client using token from runtime/dashboard bootstrap.
- Settings shows:
  - coordinator health
  - OpenAI health
  - Codex MCP status
  - `AGENTS.md` status
  - ignored paths
  - model
  - ports
  - export/data controls

E2E / ship gate:

- Dashboard loads from `rebase`.
- Navigation works across all six pages.
- Health state updates without refresh.
- Coordinator disconnected state is clear.
- Settings correctly reports missing OpenAI key.
- Settings correctly reports Codex MCP missing/present.
- Playwright validates page load, navigation, and health states.

## Phase 11: Sessions Worktree Map

Goal: make the animated tree/worktree map the main product surface.

Build:

- Use `@xyflow/react`.
- Sessions page hero shows:
  - repo root/main branch
  - worktrees
  - active agent sessions
  - changed contract surfaces
  - risk/convergence edges
- Animation semantics:
  - normal active work animates subtly
  - convergence edge appears when surfaces overlap
  - medium/high risk pulses/glows
  - resolved conflicts calm down/disappear
- Selecting a node shows:
  - worktree details
  - changed files
  - latest fingerprint
  - MCP join/checkpoint status
- Selecting a risk edge opens conflict detail.

E2E / ship gate:

- With mocked event stream, graph renders repo + two worktrees.
- Editing worktree A updates its node.
- Editing related surfaces in A and B creates convergence edge.
- Clicking convergence edge opens correct conflict detail.
- No visual overlap at desktop and laptop viewport sizes.
- Browser Use visual verification confirms graph is nonblank, readable, polished, and animation communicates risk.

## Phase 12: Conflict, Intervention, Agent Pages

Goal: complete the management UI around the live map.

Build:

- Agents page:
  - joined agents
  - unjoined active worktrees
  - last MCP checkpoint
  - current task/plan
  - unread notifications
- Conflicts page:
  - open/acknowledged/resolved/ignored filters
  - evidence view
  - confidence/risk
  - affected surfaces/worktrees
  - lifecycle actions
- Interventions page:
  - drafts
  - sent directions
  - fetched/acknowledged status
  - edited user text
- Keep text utility-focused, not marketing copy.

E2E / ship gate:

- Conflict created by fixture appears in Conflicts page.
- Acknowledge/ignore/resolve actions update DB and UI.
- Advisory edit/send creates intervention record.
- Agent page shows fetched intervention after MCP call.
- All pages survive coordinator restart with persisted state.

## Phase 13: Fixture Eval System

Goal: prove Rebase works with repeatable cases before live-agent demos.

Build:

- `packages/evals` with fixture format:
  - repo language
  - base files/surfaces
  - worktree A diff
  - worktree B diff
  - expected risk
  - expected conflict surface
  - expected false/true positive label
- Include TS/JS, Python, Java cases.
- Include conflict and non-conflict controls.
- Evals page can:
  - run fixtures
  - show recall
  - show false positives
  - show latency
  - export JSONL/CSV
- CLI/dev script can run evals headlessly.

E2E / ship gate:

- Fixture eval run completes without OpenAI by using mocked responses.
- OpenAI-enabled run works when key is present.
- Metrics calculate correctly.
- Non-conflict controls do not inflate recall.
- Exports include case id, expected risk, actual risk, latency, verdict, and evidence.
- Evals page displays latest run and historical runs.

## Phase 14: External Todo Demo Repo

Goal: validate that Rebase works on an arbitrary standalone project.

Build outside Rebase repo:

- Standalone Next.js + Drizzle SQLite todo app.
- Clear conflict surfaces:
  - Task schema
  - tasks API
  - shared Task type
  - TaskCard props
  - auth route/middleware
  - utility function
- Add several prepared task pairs for manual/live demos.
- Rebase repo docs reference this as an external path, not embedded code.
- Use normal flow:
  - `cd /path/to/todo-demo`
  - `rebase`

E2E / ship gate:

- Rebase runs from the todo repo with no Rebase source-relative assumptions.
- Existing worktrees are discovered.
- Two Codex sessions in separate worktrees can join via MCP.
- Live edits to Task contract create conflict before commit.
- Dashboard map shows convergence on Task contract.
- Codex checkpoint returns the risk notification.
- User sends edited advisory direction.
- Codex fetches intervention through MCP.

## Phase 15: Full Local Alpha Release Gate

Goal: confirm the full product is ready to share as an open-source local alpha.

End-to-end scenario:

1. Create or clone arbitrary git repo.
2. Run `rebase`.
3. Accept `.gitignore` and `AGENTS.md` setup.
4. Configure Codex MCP if missing.
5. Create two git worktrees externally.
6. Start Codex in one worktree and have it join/checkpoint.
7. Modify related contract surfaces in both worktrees.
8. Rebase detects live conflict before commit.
9. Dashboard map shows convergence.
10. Conflict page shows confidence + evidence.
11. User edits and sends advisory direction.
12. Codex fetches direction through MCP.
13. Later fingerprints show risk gone.
14. Conflict resolves or user marks resolved.
15. Eval fixtures run and export metrics.

Ship criteria:

- All automated tests pass.
- Full local alpha scenario passes twice from a clean repo.
- No raw diffs are persisted by default.
- Missing OpenAI key produces clear degraded mode.
- Missing Codex MCP produces clear setup guidance.
- Dashboard is visually polished in Browser Use verification.
- README explains install-from-source, `rebase` command, Codex setup, privacy model, known limitations, and standalone demo repo flow.

## Deferred Until After Local Alpha

- Convex/cloud sync.
- Nia integration.
- Tensorlake merge simulation.
- Claude Code plugin packaging.
- tmux alert injection.
- Desktop app packaging.
- Multi-repo dashboard.
- Multi-laptop/team relay.
- Deep AST semantic graph.
- Blocking commit hooks.
- Published npm/distribution polish beyond thin CLI.
