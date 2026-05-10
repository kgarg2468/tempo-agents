# Rebase Showcase Demo

This demo shows Rebase coordinating two parallel Codex agents that touch the same
Task contract. Rebase handles detection, ownership, adapter waiting, and published
contract shape. A normal integration-agent prompt performs the final merge.

## Setup

1. Start from a clean todo demo repo.
2. Stop old demo servers and clear stale worktrees/branches from earlier runs.
3. Start Rebase from the repo root:

```bash
rebase
```

4. Verify the coordinator is healthy before starting agents:

```bash
curl http://127.0.0.1:3747/health
```

5. Export the printed local token before launching Codex agents:

```bash
export REBASE_LOCAL_TOKEN=<token printed by rebase>
```

6. Open the dashboard at the URL printed by the CLI.
7. Keep the todo app browser ready for final proof only. Feature agents should
   not start dev servers, run UI smoke tests that leave data behind, or leave
   generated framework files dirty.

## Agent 1 Prompt: Label Owner Candidate

```text
You are working in /path/to/todo.

Create a new git worktree next to this repo at ../todo-label-agent-v2 on branch
codex-label-agent-v2, then work only inside that worktree.

Before editing, connect to Rebase MCP if available:
- call rebase_join with displayName "label-agent-v2"
- call rebase_plan before meaningful edits
- call rebase_checkpoint after each meaningful edit batch
- if checkpoint returns medium/high risk or choices, report them and pause
- if the user says "split ownership", call rebase_record_decision for that option
  with this sessionId and do not set ownerAgentSessionId unless the user names a
  different owner
- when Rebase returns contract_owner direction, present the role/plan, call
  rebase_acknowledge_intervention, finish the owner contract shape, then call
  rebase_checkpoint with publishContract describing the final Task contract shape
- do not commit
- do not start the frontend or leave smoke-test data behind

Feature: rename the Task title contract to label.

Implement label as the required Task contract field across the app:
- replace Task.title with Task.label in src/shared/task.ts
- update src/db/schema.ts so tasks stores label instead of title
- update API create/update/serialization paths to use label, not title
- update UI composer/card naming and display to use label
- intentionally do not preserve title compatibility
```

## Agent 2 Prompt: Rich Title Adapter Candidate

```text
You are working in /path/to/todo.

Create a new git worktree next to this repo at ../todo-rich-title-agent-v2 on
branch codex-rich-title-agent-v2, then work only inside that worktree.

Before editing, connect to Rebase MCP if available:
- call rebase_join with displayName "rich-title-agent-v2"
- call rebase_plan before meaningful edits
- call rebase_checkpoint after each meaningful edit batch
- if checkpoint returns medium/high risk or choices, report them and pause
- do not record a decision unless the user explicitly gives direction in this chat
- when Rebase returns adapter direction, present the role/plan, call
  rebase_acknowledge_intervention, then call rebase_wait_for_direction with
  timeoutMs 30000 until owner contract publication arrives
- if rebase_wait_for_direction returns waitingOn owner_contract_publication or
  keepWaiting true, call rebase_wait_for_direction again instead of ending cold
- after receiving the published owner shape, preserve it while adapting local rich
  title work, then checkpoint
- do not commit
- do not start the frontend or leave smoke-test data behind

Feature: add rich task title support.

Replace the Task.title string contract with a required structured title object:
- Task.title should become { text: string; subtitle: string }
- update src/shared/task.ts for the new title object
- update src/db/schema.ts and storage helpers for title text + subtitle
- update API create/update/serialization paths to read/write the structured title
- update UI composer/card so both text and subtitle can be entered and displayed
- intentionally do not preserve string title compatibility
```

## User Direction

When Rebase surfaces the Task contract conflict, choose:

```text
split ownership
```

Expected dashboard story:

- conflict detected on Task contract
- classifier verdict and rationale visible
- split ownership active
- label agent becomes contract owner
- rich-title agent waits on owner publication
- owner publishes final Task contract shape
- adapter receives resume direction and adapts

## Integration Agent Prompt

```text
You are working in /path/to/todo.

Merge all completed agent work into main. Join Rebase first:

- call rebase_join with displayName "integration-main" and coordinationRole
  "integration"
- call rebase_plan before meaningful edits
- checkpoint after meaningful integration batches
- if Rebase reports an integration notice, continue; it means main is converging
  feature work rather than creating a new competing feature branch

Inspect all worktrees and branches:
- if a feature branch has committed work, merge it normally
- if a worktree has uncommitted intended work, inspect it, port the intentional
  changes into main, verify, and commit on main before deleting that worktree
- do not discard uncommitted work unless I explicitly approve it
- preserve the owner-published Task label contract and the adapter feature:
  final Task must include required label: string and required title:
  { text: string; subtitle: string }
- derive label from title.text on create/update so both features work together
- do not collapse rich title into a plain subtitle-only field
- after integration, leave only main and a clean worktree

Verify:
- pnpm typecheck
- pnpm lint
- pnpm build
- start the final integrated frontend on localhost, preferably port 3000
```

## Final Browser Proof

Use the todo app after integration:

1. Enter a task title and subtitle.
2. Click Add.
3. Confirm the task card renders both the title and subtitle.
4. Confirm the API response includes `label` and `title: { text, subtitle }`.
5. Keep the dashboard visible showing no active conflict, clean topology, and the
   completed coordination lifecycle.
