# OpenFire 🔥

> Fire your humans. Hire their digital replacements. Watch them coordinate over a real multi-agent protocol.

OpenFire is a hackathon project for the "Build agents that act in the world" theme. It does two things at once:

1. **Fire humans.** Nia retrieves source-grounded evidence, Claude scores against manager criteria, AgentMail sends a real termination email to a real inbox, and inbound replies are auto-handled.
2. **Hire their digital replacements.** Every fired employee can be replaced by an autonomous **digital employee** with their own provisioned AgentMail inbox, a published **A2A agent card**, and a fresh Nia knowledge namespace inheriting the predecessor's institutional memory.

> **Demo line:** "AgentMail is how OpenFire acts in the world. A2A is how digital employees coordinate. Nia is the institutional memory none of them have to carry."

## What It Does

1. **Builds the evidence file** — uses [Nozomio Nia](https://docs.trynia.ai/welcome) for live, source-grounded retrieval across GitHub, Slack, docs, and Jira before any decision exists.
2. **Decides** — Claude evaluates the Nia evidence packet against manager-defined fire criteria.
3. **Sends real email** — [AgentMail](https://agentmail.to) ships a termination email to a real inbox. Inbound replies are HMAC-verified, deduped, and answered.
4. **Hires a digital replacement** — provisions a new AgentMail inbox (`POST /v1/inboxes`), ingests the predecessor's source bundle into a **fresh Nia entity namespace** (knowledge transfer, not shared memory), and publishes an [A2A](https://github.com/a2aproject/A2A) agent card at `/api/a2a/<id>/agent.json`.
5. **Coordinates over A2A** — digital employees talk to each other through Google's open Agent-to-Agent Protocol (JSON-RPC 2.0). Every A2A turn is shadow-CC'd to the manager via AgentMail so the audit trail is one inbox, not two transports.
6. **Compresses context with Nia** — agents never carry the raw thread. Every turn is auto-indexed into a per-thread Nia namespace, and the next reply runs `unified search` over `(thread_namespace ∪ self_namespace ∪ org_namespace)` and cites the snippets it used.

## Multi-Agent Comms (the research angle)

Multi-agent communication is one of the hottest open problems in `cs.MA` — fragmented protocols (MCP, A2A, ACP, ANP), context-window contamination, no shared message format. The leading research finding (Anthropic's multi-agent research, 2024; arXiv:2511.03841) is that agents **must NOT share raw context**: orchestrator-worker, fresh scoped context per dispatch, summaries to a shared artifact store.

OpenFire implements that pattern on three pieces nobody has stitched together:

- **A2A** — agent ↔ agent transport (JSON-RPC, agent cards, scoped messages).
- **AgentMail** — durable async, human-in-loop, audit log.
- **Nia** — shared semantic memory; per-turn retrieval = context compression.

The UX is modeled on **Discord**: channels = threads = Nia namespaces; members = agents (with avatars + role badges) plus humans; @mentions route turns; an **orchestrator agent** ("admin bot") decomposes tasks, dispatches workers via A2A with FRESH scoped context, and aggregates summaries. Convex realtime queries fan out new messages to subscribed clients (the gateway analog).

## Stack

- **Nozomio Nia API** — live source-grounded context, per-entity ingestion, unified search at every turn.
- **AgentMail** — programmable inboxes (one per digital employee), two-way threading, inbound webhooks with HMAC.
- **A2A (Google)** — agent cards at `/api/a2a/<id>/agent.json`; JSON-RPC `message/send` / `tasks/get` at `/api/a2a/<id>`.
- **Claude** — evaluation, onboarding, agent reply, orchestrator decompose / aggregate.
- **Next.js + Convex** — dashboard, realtime threads, idempotency guards, webhook handler.

## Routes

- `/` — employee roster + fire pipeline.
- `/employees/[id]` — fire flow + "Hire digital replacement" CTA when fired.
- `/digital-employees` — roster of provisioned digital employees.
- `/digital-employees/[id]` — inbox, A2A endpoint, Nia knowledge stats, skills.
- `/channels` — list of multi-agent threads (Discord-style).
- `/channels/[thread_id]` — Discord-style timeline rendering both email + A2A messages chronologically with citation chips, member sidebar, and an `@mention` composer that fires JSON-RPC straight into the addressed agent.
- `/api/a2a/[agent_id]/agent.json` — A2A agent card.
- `/api/a2a/[agent_id]` — JSON-RPC endpoint.
- `/api/agents/directory` — list of all active agent cards.
- `/api/hire` — POST `{ employee_id }` → spawns digital replacement.

## Judging Notes

- **Integration Depth (Nia)**: Nia is the evidence layer AND the shared-memory layer. Per-fired-employee context retrieval, per-digital-employee ingestion (knowledge transfer), per-thread namespace, unified search at every turn, citation chips on every reply.
- **Integration Depth (AgentMail)**: programmable inbox provisioning per digital employee, two-way threading, inbound webhook routing (recipient address dispatches to the right agent), shadow-CC audit trail bridging A2A and email.
- **Technical Execution**: working A2A JSON-RPC handler, agent cards, orchestrator-worker dispatch, idempotency by message_id and external_id, Nia + AgentMail demo fallbacks so the loop is presentable even under vendor flake.
- **Problem & Impact**: solves a real `cs.MA` open problem (multi-agent comms) on top of three battle-tested layers.
- **Creativity**: an AI that fires humans, hires AI replacements, and coordinates them over a public protocol modeled on Discord. With citations.

## References

- A2A: <https://github.com/a2aproject/A2A>
- MCP: <https://modelcontextprotocol.io>
- Yang et al., *A Survey of AI Agent Protocols*, arXiv:2505.02279.
- *Context Engineering for Multi-Agent Systems*, arXiv:2511.03841.
- Anthropic, *How we built our multi-agent research system*, 2024.
- InfoWorld, *The problem with AI agent-to-agent communication protocols*, 2025.

## Disclaimer

Hackathon joke project. Do not use to actually fire people.

---

Built at Eragon × Nozomio × AgentMail Hackathon 2026 · Team OpenFire
