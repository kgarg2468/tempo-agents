# Context Provider Adapter Gates

Rebase V1 must work with every external context provider disabled. Native code,
worktree, evidence, decision, and conflict facts live in the local Rebase SQLite
store first.

External adapters for Nia, CodeGraphContext, Codebase-Memory, Graphify, Mem0,
Graphiti/Zep, GraphRAG, or similar systems are allowed only after all gates pass:

1. Write an ADR that names the provider, data sent, data retained, failure mode,
   local fallback behavior, and demo value.
2. Get explicit Krish approval in the issue/plan before implementation starts.
3. Keep the provider behind a disabled-by-default adapter flag.
4. Prove Rebase still passes tests and the two-Codex local demo with the adapter
   disabled.
5. Show the Privacy tab packet that would leave the machine, including
   timestamps, provider, redactions, and sent context.

The default adapter implementation is `NativeRebaseContextProvider`. The
`DisabledExternalContextProvider` exists to make the off-by-default behavior
testable and explicit.
