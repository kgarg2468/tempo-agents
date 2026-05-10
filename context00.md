# 00context.md — Chapman Showcase Build

## The event

- **Chapman Engineering Showcase**, Friday May 8, 2026, 11am–1pm
- **Format:** walk-up demo on my laptop. No poster. Faculty + students cycle through, ~5 min each
- **Judging:** Problem Definition, Application of Engineering Knowledge, Design & Implementation, Presentation
- **Top 3 = cash prizes**
- Day before the Nozomio hackathon (May 9). Same project, two presentations.

## What we're building

A real-time conflict prediction layer for parallel AI-assisted development. Two coding agents (Codex and Claude Code) work on the same repo simultaneously, on different tasks. Our tool watches both, predicts semantic/architectural conflicts before they manifest, suggests a unified spec, and optionally re-prompts the agents to course-correct.

**Working name:** TBD. Candidates: Diverge, Refrain, Lockstep, Rebase. Pick before code starts.

## Locked design decisions

1. **Reactive first, predictive as soft-warning add-on.**
   - Reactive (live diff fingerprinting + conflict detection) is the centerpiece.
   - Predictive (compare task prompts before agents start) is a feature on top — shows up as a soft yellow warning at task assignment time. Not the main story.

2. **Resolution = suggest unified spec, then optional human-in-the-loop re-prompt.**
   - When conflict is predicted, our tool generates a unified spec showing how both intents can coexist.
   - Human user (the dev) sees a notification: *"Conflict detected — want our tool to re-prompt the agents with a unified spec?"*
   - User clicks accept → tool injects the new spec into both agent sessions.
   - User clicks ignore → conflict prediction is logged, work continues, mistakes happen, we capture data on missed prevention.
   - **Never autopilot. The user is always in the loop on re-prompting.**

3. **This is real software, not a demo prop.** Goal is to release this publicly post-Showcase. People should be able to install it and use it on real projects.

4. **Demo harness = toy todo app.** Tiny project the two agents work on during demos. Schema + API + frontend. Small enough that judges can grok the conflict in 5 seconds. Separate repo from the tool itself.

## The two-agent setup (demo)

- Single laptop. Two terminal panes (tmux).
- **Pane 1:** Codex CLI working in `worktree-A/`
- **Pane 2:** Claude Code working in `worktree-B/`
- Both worktrees are checkouts of the same toy repo (git worktrees, not clones).
- **Pane 3 / browser:** our tool's dashboard — fingerprints streaming, conflict predictions, spec suggestions.
- Each agent gets a task prompt at the start. They run autonomously.

## How the tool works

### Architecture (high level)

```
[Codex agent]     [Claude Code agent]
     |                    |
     v                    v
  worktree-A         worktree-B
     |                    |
     +--> File watcher <--+
              |
              v
     Fingerprint extractor (small model)
              |
              v
        Convex (real-time sync)
              |
              v
   Prediction agent (queries Nia for repo grounding)
              |
              +--> Dashboard UI (alerts + spec suggestions)
              +--> Re-prompt injector (if user accepts)
```

### Components

- **File watcher** — detects diffs in each worktree as agents write. Debounced (every ~2s of idle = trigger).
- **Fingerprint extractor** — small model call. Takes a diff, outputs structured intent: `{files_touched, symbols_added, symbols_modified, semantic_summary, schema_changes}`. Compresses raw code into structured signals so we don't ship raw code over the wire.
- **Convex sync** — real-time shared session state. Both agents' fingerprints land here, dashboard reads from here, alerts fire from here.
- **Prediction agent** — given two current fingerprints + Nia-indexed repo context, decides: collision risk (low/med/high), conflict type (schema / contract / architectural / intent), suggested unified spec.
- **Dashboard** — Next.js + shadcn. Two columns (one per agent) showing live work. Center alerts with diff view + spec suggestion. Re-prompt button.
- **Re-prompt injector** — when user clicks accept, sends a new prompt into both agent sessions. For Codex CLI: writes to its stdin or a known control file. For Claude Code: hooks into its API or session control if exposed; fallback is writing a file the agent reads.

### Fingerprint shape (proposed)

```json
{
  "agent_id": "codex" | "claude_code",
  "timestamp": 1715200000,
  "files_touched": ["src/models/task.ts"],
  "symbols": {
    "added": ["Task.priority"],
    "modified": ["TaskSchema"],
    "removed": []
  },
  "schema_changes": [
    { "model": "Task", "field": "priority", "type": "enum" }
  ],
  "semantic_summary": "Adding priority field to Task model with enum type",
  "in_progress_commit_message": "feat: add task priority"
}
```

Two of these next to each other = the prediction agent's input.

### Tech stack

- **Nia** — indexes the toy repo + dependencies. Prediction agent queries Nia to ground predictions in actual codebase architecture. *"The Task model is the authoritative schema, both diffs touching it = high collision."*
- **Convex** — real-time sync of fingerprints + dashboard state across panes / browser.
- **Tensorlake** — *optional, if time*. Spawn ephemeral sandbox to run "merge simulation" — try the merge, run tests, return result. Demo wow but not required for v1.
- **Vercel + Next.js + shadcn** — dashboard UI.
- **InsForge** — only if we need auth/db beyond the hackathon scope. Probably skip for Showcase.
- **Claude API (Haiku)** — fingerprint extraction, prediction agent, spec synthesis.
- **Bun or Node** — file watcher daemon, agent control plumbing.
- **Git worktrees** — to give each agent its own filesystem view of the same repo.

## What I need to build (rough order)

1. **The toy repo** — small todo app, clean schema, easy to make conflicts in.
2. **Two-worktree setup script** — one command spins up `worktree-A` and `worktree-B`.
3. **File watcher + fingerprint extractor** — the daemon that watches both worktrees and emits fingerprints.
4. **Convex schema + sync** — shared state for fingerprints, alerts, prediction history.
5. **Prediction agent** — Claude API call that takes two fingerprints + Nia context, outputs conflict verdict + unified spec.
6. **Dashboard** — Next.js, two-column live view, alert panel, re-prompt button.
7. **Re-prompt injection** — figure out how to send a new prompt into a running Codex / Claude Code session. This is the hairy part — investigate early.
8. **Eval harness** — script that runs N task-pair experiments overnight, logs results.
9. **The 5-minute demo flow** — task-pair menu, scripted prompts, practice run.

## The eval (run this overnight before Showcase)

This is what turns a cool demo into an engineering project.

### Setup

- Pre-define 20 task pairs that *should* conflict. Examples:
  - "Add priority field to Task" / "Add tags field to Task"
  - "Add JWT auth middleware" / "Add OAuth login route"
  - "Rename utility function `formatDate`" / "Add new caller of `formatDate`"
  - "Refactor TaskList component" / "Add new prop to TaskList"
- Pre-define 5 task pairs that *shouldn't* conflict (control). Different files, different concerns.
- For each pair, run 3 conditions:
  - **(a) Sequential single agent** — baseline. One agent does both tasks one after the other. Measures: total tokens, time, lines of code.
  - **(b) Parallel without tool** — two agents, no intervention. Measures: same + did conflict happen at merge.
  - **(c) Parallel with tool** — two agents + our tool. Measures: same + did our tool catch the conflict + was the unified spec adopted.

### Metrics to collect

- Total tokens per task pair (sum across both agents)
- Wall-clock time
- Did a real conflict materialize (binary, post-hoc git merge)
- Was conflict caught by our tool (true positive / false negative)
- False positive rate (alerts fired on non-conflicting pairs)
- Latency of conflict prediction (ms from diff → alert)
- Code quality after merge (linter pass, test pass rate)

### What to report at the Showcase

- "Across 20 conflicting task pairs and 5 non-conflicting controls:"
  - "We caught X of Y real conflicts" (recall)
  - "We falsely flagged Z of 5 non-conflicting pairs" (false positive rate)
  - "Average tokens saved per caught conflict: N"
  - "Average prediction latency: M ms"

Numbers stick. Have these printed on the one-pager.

## The 5-minute demo flow (Showcase)

Faculty walks up. Laptop is open. Two agents are NOT yet running (cleaner — let the judge trigger).

**0:00 — 30s pitch**
*"Two AI coding agents working on the same codebase in parallel. Our tool predicts semantic conflicts between them before either commits, then suggests a unified resolution. Pick a task pair."*

Hand them a printed card with 6 task pairs.

**0:30 — they pick (15s)**
They circle one. I paste the two prompts into the two agent panes. Hit go.

**0:45 — agents run live**
Both agents start. Dashboard fills in: file changes, fingerprints, semantic summaries.

**1:30 — alert fires**
Yellow → red on dashboard. Click. *"Codex is adding `priority` to Task. Claude Code is adding `tags` to Task. Both touching the same migration file. Conflict in 30 seconds if we let them continue."*

**2:30 — show the unified spec**
Dashboard shows generated spec: combined migration, both fields, no collision. *"Want to re-prompt the agents with this spec?"*

**3:00 — click accept**
Spec injects into both sessions. Both agents adopt it. Continue. Final commits land cleanly.

**3:30 — show the numbers**
Open eval dashboard. *"We ran this 20 times overnight: 94% recall, 11% false positive, 8400 tokens saved per caught conflict on average."*

**4:00 — Q&A / deeper dive**
If they want architecture: pull up the diagram. If they want failure modes: pull up the missed-conflict logs.

### Backup plans

- If live agents glitch: pre-recorded demo video as fallback.
- If WiFi dies: local-only mode with cached Nia results for the 6 task pairs on the menu.
- If a judge wants something not on the menu: politely say "we tested these 6 thoroughly, here's why" and pivot back.

## The leave-behind one-pager

No poster, but a printed one-pager is free credibility:

- **Front side:** project name + 1-sentence description, architecture diagram, key results numbers.
- **Back side:** problem statement, related work positioning (Cursor multiplayer / Sourcegraph Cody / Graphite — *"these operate post-write and single-agent; we operate pre-write and multi-agent"*), my contact / GitHub / QR to repo.

## Open framing decisions (decide later, not blocking the build)

These don't affect the code. They affect how we *pitch* the project at the Showcase. Pick one or two before May 8.

1. **Engineering contribution sentence** — pick one to lead with:
   - *"Real-time intent fingerprinting — compressing in-progress code changes into structured signatures fast enough to compare across N developers."* (systems contribution)
   - *"Multi-agent orchestration via shared context — using indexed repo knowledge to predict and resolve task-level conflicts."* (coordination contribution)
   - *"Cost-aware agent supervision — minimizing wasted token spend in parallel AI-assisted development."* (efficiency contribution)

2. **My top picks for additional rigor angles** (from earlier brainstorm):
   - **Control study (3-way comparison: sequential / parallel-no-tool / parallel-with-tool).** Highest payoff. Numbers faculty cannot ignore. Already kind of baked into the eval plan above.
   - **Ablation study (what happens without Nia / without fingerprint compression / without semantic similarity).** Same overnight infra, marginal extra work, very faculty-friendly.
   - **Related work positioning (Cursor multiplayer, Sourcegraph Cody, Graphite, Copilot Workspace).** 1 hour of writing, answers the "isn't this just X?" question 20 times.
   - **Orchestration framing (recast as "novel coordination primitive for parallel LLM agents").** Same code, bigger pitch.

3. **The hackathon-vs-showcase pitch shift:**
   - At Showcase: lead with "real-time intent fingerprinting" + control-study numbers.
   - At hackathon: lead with "cost-reduction for AI-native teams" + token-spend dollar figures.
   - Same project, different opening sentence.

## Personal context (for whatever agent helps me build)

- Use-Anything (CLI that auto-generates SKILL.md from any software) — relevant: the fingerprint extractor is doing similar structural-summarization work.
- Unvibe (skill bundle, router-on-skills patterns) — relevant: the re-prompt injector is essentially injecting a new skill mid-task.
- AEGIS (RL cybersecurity defense, GNN+LSTM) — proves I can ship ML systems if asked.
- Wooly (on-device voice agent, hardware) — relevant if we add the privacy-preserving "fingerprints extracted locally" angle.
- Direct, terse communication style. Open-source first. "Building for agents, not just with them."

## Risks and unknowns

- **Re-prompt injection is the hardest part.** Codex CLI and Claude Code don't have official "send new prompt to running session" APIs. We'll need to figure out a workaround per agent — control file, stdin pipe, MCP intervention. **Investigate this in the first 24 hours.** If it's blocked, fall back to: tool generates the unified spec, user manually pastes it into both agents. Less wow, still works.
- **Fingerprint quality.** A bad fingerprint extractor = bad predictions. Iterate on the prompt for this. Save examples that fail and tune.
- **Latency.** Need <2s from diff to alert for a credible "real-time" claim. Profile early.
- **Toy app needs to actually produce conflicts.** Small repo means fewer conflict surfaces. Design the schema/API specifically to give the 20 task pairs natural collision points.
- **Faculty might ask "isn't this just MCP / Cursor multiplayer / Sourcegraph?"** Have a one-line answer for each, ready.

## Definition of done (for Showcase, not hackathon)

- Tool runs end-to-end on my laptop with two real agents.
- Eval data exists for at least 15 of 20 task pairs (3 conditions each = 45 runs minimum).
- Dashboard is presentable, not janky.
- 5-min demo runs reliably 5 times in a row in practice.
- One-pager printed and laminated.
- Repo is public, README is clean, install instructions work.
