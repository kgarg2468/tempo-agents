# Rebase — build context

This document is for a coding agent implementing Rebase. Read top to bottom before writing code. When in doubt, prefer the **Open decisions** section over guessing — surface the question to Krish rather than picking.

---

## One-liner

A real-time conflict prediction layer for AI-coding teams. Catches semantic, architectural, and intent-level merge conflicts *before* either engineer commits — built on RocketRide pipelines, exposed over MCP.

**The bigger vision:** a compatibility layer for in-flight code — every change about to be written, merged, or shipped, checked against everything else that exists or is in motion. Parallel-agent collision detection is the v1 wedge. See *Compatibility axes* below for the full frame.

---

## Why this exists (don't lose this framing)

Two engineers + two AI agents can produce a week of conflicting code in an afternoon. Git only catches textual collisions; everything above that altitude (semantic, architectural, intent) surfaces hours-to-weeks later, after both agents have already burned tokens on work that gets thrown out.

**The product is a cost-reduction tool for AI-native teams, not a productivity tool.** That framing is load-bearing for both the technical design (token-cost is the metric we surface in UI) and the pitch. Don't drift into productivity language.

### Conflict altitudes (the model)

1. **Textual** — same lines, same file. Git solves trivially. *Not our problem.*
2. **Syntactic** — same function, different lines. Git auto-merges; CI sometimes catches. *Not our problem.*
3. **Semantic** — different files, contracts mismatch (auth header changes, response shape changes). Git is blind. **Our problem.**
4. **Architectural** — both build "auth middleware" with different mental models. Both pass CI. **Our problem.**
5. **Intent** — same task assigned to two people; both ship working features. **Stretch goal — requires Linear/spec ingestion.**

Token-burn cost scales up the stack. Layer 5 is the most expensive failure mode.

---

## Compatibility axes — the bigger frame

Parallel collaboration is one slice of a bigger problem. The full problem is: *"is the code about to be written, merged, or shipped compatible with everything else that exists or is in motion?"*

Five axes, all the same fundamental shape — compatibility checks against context:

| Axis           | What's being checked                                | When             |
|----------------|-----------------------------------------------------|------------------|
| **Lateral**    | Two agents writing simultaneously                   | Now              |
| **Forward**    | Open PRs, pending branches, unmerged teammate work  | Before commit    |
| **Backward**   | Main branch, deployed code, contracts in production | Before write     |
| **Downstream** | Other services / libs / apps that consume this      | Before merge     |
| **Temporal**   | Roadmap items, planned refactors, design docs       | Before architect |

Today's tools check compatibility *after the fact* — tests fail, CI breaks, merges conflict, prod incidents. By then the tokens are spent and the rework is expensive.

Rebase checks compatibility *before the fact* by extracting intent from in-flight work and comparing against relevant context: committed, in-progress, and planned.

**v1 ships the lateral axis only.** The other four are explicitly out of scope until the v1 UX bar (defined later in this doc) is met. The framing matters for three reasons:

1. **Architectural decisions in v1 must not preclude future axes.** The fingerprint shape, MCP surface, and collision schema should generalize. Every axis is a fingerprint+collision pair where the data source changes; the pipelines stay the same. Don't bake "this fingerprint came from a live editor" into the schema — make the source pluggable.
2. **The README and pitch should hint at the bigger frame without overpromising.** Land the line *"compatibility layer for in-flight code, starting with parallel agents."* Don't ship features that would force the line to be a lie.
3. **Do not build the other axes in v1.** The UX bar comes first. The bar is the product.

---

## What Rebase actually does (behavior)

1. A daemon runs on each engineer's laptop. Watches working directory, active branch, editor events.
2. As the engineer edits, the daemon emits **intent fingerprints** — structured summaries of what they're changing. Fingerprints leave the laptop. Source code does not.
3. A central agent compares fingerprints across teammates every few seconds: are any two on a collision course?
4. If yes, it surfaces through a three-tier interruption ladder (whisper → nudge → stop), specified below.
5. When the user engages, an agent proposes a resolution. User reviews. User applies. Nothing auto-applies.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Engineer's laptop                                            │
│                                                               │
│  ┌──────────────┐    ┌──────────────────────────────────┐     │
│  │  VSCode ext  │ ←→ │  Local daemon (file watcher)     │     │
│  │  (UI surface)│    │  - Detects edits                 │     │
│  └──────────────┘    │  - Builds raw diff               │     │
│                      │  - Calls RocketRide pipeline     │     │
│                      └────────────┬─────────────────────┘     │
└───────────────────────────────────┼───────────────────────────┘
                                    │ (MCP / local pipe)
                                    ▼
┌──────────────────────────────────────────────────────────────┐
│  RocketRide engine (local OR self-hosted)                    │
│                                                              │
│  Pipeline 1: fingerprint-extract                             │
│  diff → tree-sitter AST → symbol extractor                   │
│       → semantic signature (Haiku) → fingerprint JSON        │
│                                                              │
│  Pipeline 2: collision-detect                                │
│  N fingerprints → pairwise overlap → risk classifier         │
│                → resolution proposal → conflict JSON         │
│                                                              │
│  Both exposed via MCP server                                 │
└──────────────────────────────────┬───────────────────────────┘
                                   │
                                   ▼
                       ┌────────────────────────┐
                       │  Sync layer (Postgres) │
                       │  Fingerprints + state  │
                       │  shared across team    │
                       └────────────┬───────────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │  Dashboard (Next.js)   │
                       │  Live team activity,   │
                       │  collision history,    │
                       │  privacy panel         │
                       └────────────────────────┘
```

**Critical principle:** RocketRide does the meaningful work (fingerprint extraction, collision scoring). Everything else is plumbing. If you find yourself building heavy logic outside RocketRide, stop and reconsider — that logic should be a node.

---

## RocketRide pipelines (the technical centerpiece)

### Pipeline 1: `fingerprint-extract`

**Input:** raw diff (string) + file metadata (path, language)
**Output:** fingerprint JSON

**Node chain:**

1. **`diff-parser`** — splits unified diff into hunks per file. Standard.
2. **`tree-sitter-ast`** — parameterized by language grammar. Produces AST for both before and after states. Use existing tree-sitter bindings; don't reimplement.
3. **`symbol-diff`** — diffs the two ASTs. Emits structured symbol changes: `{added: [...], renamed: [...], deleted: [...], modified: [...]}`. Each entry has type (function, class, type, schema field, export, etc.), name, and signature.
4. **`semantic-signature`** — small-model call (Claude Haiku via API for v1). Prompt: "Given this symbol diff and file context, produce a one-sentence intent summary and structured fields: `{intent, surface_area, risk_areas, inferred_commit_message}`."
5. **`fingerprint-emit`** — assembles final JSON. Schema below.

**Fingerprint JSON shape:**

```json
{
  "fingerprint_id": "fp_...",
  "user_id": "krish",
  "session_id": "sess_...",
  "timestamp": "2026-...",
  "branch": "feature/priority-field",
  "files_touched": ["models/task.ts", "migrations/003.sql"],
  "symbols": {
    "added": [
      {"type": "field", "name": "priority", "parent": "Task", "signature": "priority: Priority"}
    ],
    "renamed": [],
    "deleted": [],
    "modified": []
  },
  "semantic": {
    "intent": "Adding priority field to Task schema with enum + index",
    "surface_area": ["models", "migrations", "api"],
    "risk_areas": ["schema collision", "migration ordering"],
    "inferred_commit_message": "feat(task): add priority field"
  },
  "raw_diff_hash": "sha256:..."
}
```

The `raw_diff_hash` lets us reference the diff later without storing it. Source bytes never leave the laptop.

### Pipeline 2: `collision-detect`

**Input:** array of recent fingerprints (typically 2-N from same team's session)
**Output:** array of collision predictions

**Node chain:**

1. **`pairwise-overlap`** — for each pair of fingerprints, compute overlap scores: file-level (Jaccard on `files_touched`), symbol-level (do added symbols clash? renamed-on-both-sides?), semantic-level (cosine similarity on `intent` embeddings or LLM-judged).
2. **`risk-classifier`** — given overlap scores, classify altitude (semantic / architectural / intent) and confidence.
3. **`cost-estimator`** — estimate token-rework cost if the collision lands. Heuristic for v1: `lines_changed_both_sides * avg_tokens_per_line * 2`. Tune later.
4. **`resolution-proposer`** — LLM call (Sonnet for this; quality matters more than latency). Given both fingerprints + repo context, propose unified resolution. Output: structured patch suggestion + natural-language explanation.
5. **`conflict-emit`** — final JSON.

**Collision JSON shape:**

```json
{
  "collision_id": "col_...",
  "fingerprints": ["fp_a", "fp_b"],
  "users": ["krish", "arlan"],
  "altitude": "semantic",
  "confidence": 0.84,
  "cost_estimate_tokens": 4200,
  "summary": "Both adding fields to Task schema. Migration files will collide.",
  "files_overlap": ["models/task.ts", "migrations/003.sql"],
  "suggested_level": "nudge",
  "resolution": {
    "explanation": "Combine both fields into one migration. Renumber Arlan's 003 to 004.",
    "patch": "..."
  }
}
```

**Threshold defaults (tune empirically):**

- `confidence < 0.4` → no fire (drop)
- `0.4 ≤ confidence < 0.7` → whisper
- `0.7 ≤ confidence < 0.9` → nudge
- `confidence ≥ 0.9 AND cost_estimate > 3000 tokens` → stop

These are starting points. Build the system so they're tunable from config.

---

## MCP surface

Both pipelines exposed as MCP tools so any agent (Claude Code, Cursor, custom) can drive Rebase.

```
Tool: rebase_extract_fingerprint
  input:  { diff: string, language: string, branch: string }
  output: Fingerprint

Tool: rebase_detect_collisions
  input:  { session_id: string, lookback_minutes?: number }
  output: Collision[]

Tool: rebase_propose_resolution
  input:  { collision_id: string }
  output: { explanation: string, patch: string }

Tool: rebase_team_activity
  input:  { session_id: string }
  output: { active_users: User[], recent_collisions: Collision[] }
```

These are also how the VSCode extension talks to the engine — same MCP surface, no separate API.

---

## Interaction model (UX — the most important part)

False positives kill this product. Calibration of the three levels is the entire UX.

### Level 1: Whisper

- **Trigger:** confidence 0.4–0.7. Adjacency without predicted failure.
- **Surface:** VSCode status bar icon. Hollow circle → amber filled circle.
- **Hover tooltip:**
  ```
  2 teammates active
  ├ Arlan • models/task.ts • 4m ago
  └ Sarah • README.md      • 12m ago
  ```
- **Click:** opens team-activity side panel.
- **Never:** pulses, animates, beeps, demands attention. The whole point is it can be ignored without consequence.
- **Auto-clears** when the teammate moves to unrelated code.

### Level 2: Nudge

- **Trigger:** confidence 0.7–0.9. Predicted real collision.
- **Surface:** VSCode toast notification, persists in notification center if dismissed.
- **One nudge per collision per session.** No re-firing unless the collision materially changes.
- **Defer the toast until next typing pause >800ms.** Never fire mid-keystroke.
- **Copy template:**
  ```
  ⚠  Diverging change on {noun}

  You're {your action}. {Other person} {their action} {time} ago.
  {Specific consequence}.

  [Show me]  [Got it]  [Mute for this session]
  ```
- **Specificity is non-negotiable:** specific noun ("Task schema"), specific person ("Arlan"), specific consequence ("Migrations will collide"). Generic = ignored.
- **"Mute for session"** is required. Without it, users disable the whole extension the first time it nudges during flow.

### Level 3: Stop

- **Trigger:** confidence ≥0.9 AND cost_estimate > threshold. Fired on `git commit` (or VSCode commit button), never during typing.
- **Surface:** modal intercepting commit.
- **Layout:**
  ```
  This commit will collide with main

  3 files overlap with Arlan's commit (8m ago):
  • models/task.ts        (schema collision)
  • migrations/003.sql    (will not apply)
  • api/tasks.ts          (signature mismatch)

  Estimated rework if you commit now:
  ~4,200 tokens across both branches

  [Resolve with agent]
  [Pull & rebase first]
  [Commit anyway]

  Wrong call?  → Tell us why
  ```
- **"Commit anyway" is always present, always rightmost, always one click.** Hard blocks get the extension uninstalled.
- **"Wrong call?"** is the tuning loop. Every false positive reported here trains the threshold.
- **Token-cost line is the killer feature.** No competing tool shows this.
- **Fallback:** if prediction takes >600ms, degrade to nudge. Never make the user wait to commit.

### Resolution panel (shared by Nudge "Show me" and Stop "Resolve with agent")

- **Surface:** side panel, not modal — user wants to see code while it's open.
- **Layout:** side-by-side diffs (your change | their change), predicted merge result with failure point highlighted, agent's proposed resolution with explanation, action buttons.
- **Buttons:** `[Apply to my branch]` `[Send to Arlan]` `[Edit first]`
- **"Apply to my branch"** modifies working directory but does NOT commit. User reviews, runs tests, commits manually. Agent proposes; user decides.
- **"Send to Arlan"** sends the proposal to Arlan's editor as a nudge with resolution pre-filled. Resolution can come from either side. This is what makes Rebase *collaboration* not just *detection*.

### Team activity view (whisper click target)

- **Surface:** VSCode side panel.
- **Shows:** all active teammates, what file/symbol they're touching, adjacency tag (`adjacent` / `unrelated`), past 24h collisions resolved, tokens saved.
- **Tab: Privacy panel.** Shows fingerprints leaving the laptop in real time, structured JSON, with a clear note that no source bytes leave. This sells the privacy story by *showing* it, not telling.

### What the *other* engineer sees

- Whispers and nudges fire **symmetrically** — both sides see the same collision, names swapped in copy.
- Stop is **asymmetric** — only the person committing gets the modal. The other person gets a nudge: "Krish is about to commit something that will collide with your branch."

### Onboarding (first 90 seconds — don't under-think)

1. Install extension.
2. GitHub OAuth → pick repo to monitor → pick teammates (default: write-access in last 30 days).
3. Empty state with screenshots of whisper/nudge/stop so user knows what to expect.
4. **"Run the demo collision"** button — fakes a teammate change in a temp branch, fires whisper-then-nudge sequence so the user *experiences* the levels before encountering them in real work. This is the move most extensions skip.

---

## Privacy model

This is a property of the architecture, not a marketing slide.

**What leaves the laptop:**
- Fingerprint JSON (symbols, semantic signatures, file paths).
- Diff hash (for reference, not reconstruction).

**What never leaves the laptop:**
- Raw source bytes.
- Raw diff content.

**Acknowledgment:** fingerprints themselves leak intent. "Adding `POST /admin/delete-all-users`" is sensitive even without code. Treat fingerprints as a *minimization*, not anonymization. Document this honestly in README. Encryption-at-rest and TLS-in-transit are table stakes.

**User controls:**
- Per-session opt-in.
- Per-file ignore list (`.rebaseignore` mirroring `.gitignore`).
- "Pause sharing" toggle in status bar.

---

## Tech stack

### Locked

- **RocketRide** — engine for both pipelines. Non-negotiable; this is the whole point.
- **MCP** — only interface between agents and pipelines. Don't build a separate REST API.
- **VSCode extension (TypeScript)** — primary editor surface. Mirrors RocketRide's existing VSCode extension pattern.
- **Tree-sitter** — universal AST parsing. One node parameterized by grammar, not one node per language.
- **Claude Haiku** — semantic-signature node (small, fast, cheap).
- **Claude Sonnet** — resolution-proposer node (quality > latency).
- **Postgres + LISTEN/NOTIFY** — cross-laptop sync. Simple, portable, no extra service.
- **Next.js + shadcn + Tailwind** — dashboard. Pattern-match RocketRide's chat-ui.

### Flexible (agent: ask before picking)

- File watcher inside daemon — `chokidar` (Node) is fast to ship; a small Rust sidecar would be more impressive. Default to Node unless Krish says otherwise.
- Auth — GitHub OAuth for v1. Keep it simple.
- Hosting — Vercel for dashboard. Engine runs locally for v1 demo; hosted RocketRide instance is post-MVP.

### Out of scope for v1 (don't build)

**Other compatibility axes — gated on the v1 UX bar:**
- **Forward axis** — checking against open PRs and unmerged branches.
- **Backward axis** — checking against main / deployed code / live contracts.
- **Downstream axis** — checking against consumer services and libraries.
- **Temporal axis** — checking against roadmap, design docs, planned refactors.

The architecture for v1 should leave room for these (see *Compatibility axes* earlier), but no implementation lands until lateral v1 clears the UX bar.

**Other deferred features:**
- Linear / Slack / Jira ingestion (feeds the temporal axis — stretch).
- Hyperspell / personal context layer.
- Tensorlake-style sandboxed merge simulation (cool but heavy).
- Multi-repo session support.
- Cursor extension (VSCode first).
- Local-only models (use API for v1).
- Adversarial-fingerprint defense.
- Mobile/web client.

---

## Repo structure

```
rebase/
├── README.md                  # the pitch + install + demo gif
├── LICENSE                    # MIT
├── packages/
│   ├── extension/             # VSCode extension (TS)
│   │   ├── src/
│   │   ├── package.json
│   │   └── README.md
│   ├── daemon/                # Local file watcher + diff builder
│   │   ├── src/
│   │   └── package.json
│   ├── pipelines/             # RocketRide pipeline definitions
│   │   ├── fingerprint-extract/
│   │   │   ├── pipeline.json
│   │   │   ├── nodes/         # custom nodes (symbol-diff, semantic-signature)
│   │   │   └── README.md
│   │   └── collision-detect/
│   │       ├── pipeline.json
│   │       ├── nodes/
│   │       └── README.md
│   ├── mcp-server/            # MCP server exposing pipelines
│   │   └── src/
│   ├── dashboard/             # Next.js dashboard
│   │   ├── app/
│   │   └── components/
│   └── shared/                # shared types (Fingerprint, Collision, etc.)
│       └── src/types.ts
├── infra/
│   └── postgres/              # schema + LISTEN/NOTIFY setup
├── scripts/
│   ├── demo-collision.ts      # fakes a collision for the onboarding "demo" button
│   └── benchmark-tokens.ts    # the experiment for the README money-shot numbers
└── docs/
    ├── architecture.md
    ├── privacy.md
    └── pipelines.md
```

Monorepo with pnpm workspaces. Mirror this if you have a strong reason; deviate only after asking.

---

## Edge cases (treat these as test cases)

- **Paired engineers** on the same task — same intent, same files. Don't fire. Provide an explicit "we're paired, suppress" affordance.
- **Rebase / merge in progress** — touches hundreds of files mechanically. Detect (`.git/rebase-*` exists, `MERGE_HEAD` exists) and silence.
- **Generated files** — lockfiles, ORM-generated migrations, schema dumps. Skip via gitignore-style rules; default ignore list ships with extension.
- **Large mechanical refactors** (rename one symbol across 80 files) — produce ONE fingerprint, not 80. Group by intent.
- **Multiple agents per human** (Cursor + Claude Code + manual) — treat as one stream per laptop, not per agent. Provenance is the laptop, not the tool.
- **Teammate offline** — drop stale fingerprints rather than queue. Stale fingerprints fire false positives.
- **Force pushes / amended commits** — fingerprints are tied to *intent*, not commit hashes. Never reference a commit SHA in a fingerprint.
- **Symbol shadowing across packages** — `auth.login` in package A vs B. Disambiguate by full module path, not bare symbol name.
- **Long pauses** — engineer goes to lunch. Fingerprints expire after configurable TTL (default 60min) so they don't haunt the team.
- **Solo dev mode** — Rebase should still do something useful for one person. Detect "you're undoing work you did 3 days ago" or "you're diverging from your own feature branch's earlier intent." Widens demo audience.

---

## Demo flow (for README and pitch)

Two terminals on one machine, two fake users. (Or two laptops if you have a partner.)

1. Both run Claude Code on the same shared project (small auth service or todo app).
2. User A: "add a `priority` field to Task." User B: "add a `tags` field to Task." Both start coding.
3. ~20s in: status bars on both glow amber.
4. ~10s later: nudge fires on both. "Both adding fields to Task schema. Migration files will collide."
5. Click "Show me." Resolution panel opens. Side-by-side diff. Agent proposes unified migration.
6. Click "Apply to my branch." User A's working directory updates. Both Claude Code sessions adopt.
7. Both commit cleanly.
8. **Money slide** in README: "Without Rebase: 47k tokens, 12k wasted on conflict resolution. With Rebase: 31k tokens, 0 wasted." Numbers from a pre-run experiment, not estimated.

The token-cost numbers are the single most important deliverable for the README. Run the experiment before writing the post.

---

## UX quality bar — the v1 gate

Before any axis expansion, before any new feature, the lateral v1 must be good enough that **Krish uses it for real work for at least a week** AND **a friend would install it today to coordinate with a teammate or manage multiple agents in parallel**.

This is not a soft target. It is a gate. If the bar is not met, do not start on Forward / Backward / Downstream / Temporal axes. Fix the bar. **The bar is the product.**

### Functional bar

- Install-to-first-collision-detected works end-to-end in under 5 minutes on a fresh machine.
- Zero false positives in a normal solo workflow over a 2-hour coding session.
- Per-keystroke fingerprint emission stays under 800ms p95.
- Collision detection latency stays under 2s p95 from the moment the second teammate's edit lands.
- Resolution panel produces actually-applicable patches in ≥70% of fired nudges during dogfooding.

### Interaction bar

- A new user understands whisper / nudge / stop within 90 seconds of install — verified via the onboarding "demo collision" flow.
- Whisper never demands attention. Nudge never fires mid-keystroke. Stop is never the only way out — *commit anyway* always works in one click.
- *Mute for session* is reachable from every nudge in one click.
- *Wrong call?* feedback path exists on every fired alert and writes to a log Krish can review weekly to retune thresholds.

### Trust bar

- Privacy panel shows live fingerprints leaving the laptop, structured JSON, in real time.
- Source bytes appear nowhere outside the local daemon. Verifiable by reading network logs with the panel open.
- README addresses fingerprint leakage honestly: fingerprints are *minimization*, not anonymization.

### Polish bar

- Demo GIF in README shows the actual product working, not a mockup.
- README money-shot has real token-cost numbers from `scripts/benchmark-tokens.ts`, not estimates.
- Status bar icon, side panel, resolution panel, and modal all match VSCode's native visual language. No custom "AI app" aesthetic.
- One-keystroke uninstall path. The user must always feel in control.

### Dogfooding requirement

Krish runs Rebase on his own real work — Unvibe, Use-Anything, Wooly, whatever's in flight — for at least **5 working days** before v1 is declared done. Bugs and friction surfaced during dogfooding are P0 until the bar is met.

The "would I use this myself today?" test is the only test that matters. If the answer is no, fix that first.

---

## Functional acceptance criteria

- [ ] `fingerprint-extract` pipeline runs end-to-end on a real diff and produces valid fingerprint JSON.
- [ ] `collision-detect` pipeline takes 2 fingerprints and produces a collision prediction with confidence score.
- [ ] Both pipelines exposed as MCP tools and callable from Claude Code.
- [ ] VSCode extension shows status bar icon and toggles whisper state correctly.
- [ ] Nudge fires once per collision, with proper deferral past keystrokes.
- [ ] Stop modal intercepts commit and shows token-cost estimate.
- [ ] Resolution panel renders side-by-side diff and proposed patch.
- [ ] Onboarding includes the "Run demo collision" button and it actually works.
- [ ] Privacy panel shows real-time fingerprints leaving the laptop.
- [ ] README has GIF of the demo and real token-cost numbers from a benchmark script.
- [ ] Repo published, MIT-licensed, deployable by anyone with `pnpm install && pnpm dev`.

---

## Open decisions (ASK before picking)

If any of these come up while building, surface to Krish rather than choosing:

1. **Solo dev mode** — implement in v1 or defer? (Affects scope significantly.)
2. **Daemon language** — Node (fast to ship) vs Rust sidecar (more impressive). Default Node unless told.
3. **Fingerprint storage** — keep on Postgres only, or local SQLite cache for offline? Default Postgres-only.
4. **Resolution apply** — modify working directory directly, or open a pending diff in VSCode for review? Default: open as pending diff.
5. **Demo project** — what's the toy codebase the two engineers fake-edit? Default: small auth service. Confirm.
6. **Hosted RocketRide vs local-only** for v1 demo — local-only is simpler. Default local-only.
7. **Real semantic embeddings vs LLM-judged similarity** in `pairwise-overlap` node — start with LLM-judged for simplicity? Default yes, log scores for later embedding-based replacement.

---

## Anti-patterns (don't do these)

- **Don't add features Krish hasn't asked for.** This doc is the spec. If you find yourself wanting to add something, surface the question instead.
- **Don't auto-apply agent suggestions.** The user always reviews. Always.
- **Don't use the word "productivity"** in any user-facing copy or README. Cost reduction. Token waste. Engineering time. Not productivity.
- **Don't hard-block any user action.** Every modal has a "do it anyway" path.
- **Don't show raw source code in any UI panel that represents network traffic.** The privacy story dies the moment a user sees a code line in a "this is what we send" view.
- **Don't reach for Convex / Tensorlake / Hyperspell.** Those were hackathon-stack ideas. RocketRide is the engine; everything else stays minimal.
- **Don't build a generic "real-time multiplayer" framework.** This is a conflict prediction tool, not a Liveshare clone.
- **Don't over-engineer the threshold logic.** Hardcode defaults, expose them in config, tune from real data. Don't build a meta-learning system in v1.

---

## Style notes for the agent

- Krish prefers terse, direct communication. No filler. No "great question!" preamble.
- Match his existing project conventions: pnpm workspaces, TypeScript strict, MIT license, README-first.
- Open-source from day one. Public repo. Commits should read clean for hiring managers reading the log.
- When asking for a decision, present 2-4 options with a recommendation and tradeoffs. Never ask open-ended "what should I do?"
- README is part of the product. Treat it as a deliverable, not an afterthought.
- The token-cost numbers (`scripts/benchmark-tokens.ts`) are non-optional. They're the proof that everything else is real.

---

## Reference: prior work to draw on

Krish has shipped two adjacent projects worth referencing:

- **Use-Anything** (`github.com/kgarg2468/Use-Anything`) — 5-phase pipeline (Probe → Rank → Analyze → Generate → Validate) for auto-generating SKILL.md from arbitrary software. The `fingerprint-extract` pipeline is the same problem class; reuse design patterns.
- **Unvibe** — skill bundle with router-on-skills activation patterns. Relevant for the resolution-proposer agent design (how an agent decides *which* resolution skill to invoke).

When in doubt about a design choice, look at how those projects handled the analogous problem.
