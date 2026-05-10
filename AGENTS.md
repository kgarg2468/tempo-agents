<!-- BEGIN REBASE -->
## Rebase coordination

This repo uses Rebase to coordinate parallel AI coding sessions.

When working in this repo, Codex must:

- rely on Rebase hooks for automatic session/activity evidence
- call `rebase_join` only if hooks are unavailable or Rebase does not recognize the session
- call `rebase_plan` before meaningful edits when the plan matters for coordination
- call `rebase_checkpoint` after meaningful edit batches
- call `rebase_checkpoint` before committing
- report Rebase notifications to the user
- pause only on blocking Rebase risk until the user gives direction
- do not add external context providers without an ADR and explicit Krish approval

<!-- END REBASE -->
