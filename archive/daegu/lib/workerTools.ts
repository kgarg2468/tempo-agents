/**
 * Worker tool dispatcher.
 *
 * Routes a tool_use call from the runner loop to either:
 *   1. a real implementation for the CORE_TOOLS shared by every worker
 *      (reasoning logging, status updates, mark-done), or
 *   2. a stub that returns a deterministic placeholder for role-specific
 *      tools (search_codebase, research_company, etc.).
 *
 * The stubs are intentional. Role-specific tools want real integrations
 * (Nozomio, GitHub, AgentMail, ...) that aren't wired yet. Returning a
 * structured placeholder lets the tool-use loop run end-to-end so we can
 * exercise the orchestration before the integrations land.
 */

export interface ToolDispatchContext {
  taskId: string;
  workerName: string;
  workerType: string;
  /** Append a structured row to worker_task_steps. */
  appendStep: (kind: "reasoning" | "tool_call" | "tool_result" | "final", content: string, toolName?: string) => Promise<void>;
  /** Patch worker_tasks.status (and optional summary/deliverable). */
  setStatus: (
    status: "in_progress" | "waiting_input" | "done" | "failed" | "refused",
    extras?: { result_summary?: string; deliverable_url?: string; error?: string; finished?: boolean }
  ) => Promise<void>;
}

export type LoopFinalStatus =
  | "done"
  | "failed"
  | "refused"
  | "waiting_input";

export interface ToolResult {
  ok: boolean;
  /** JSON-serializable payload that becomes the tool_result content. */
  output: unknown;
  /** When set, the runner exits the loop after appending this result. */
  endsLoop?: boolean;
  /**
   * When `endsLoop` is true, the runner uses this as the action's final
   * status so the return value matches whatever the tool wrote to the DB
   * via `setStatus`. Defaults to "done" if omitted.
   */
  endsLoopStatus?: LoopFinalStatus;
}

const ROLE_STUB_RESPONSES: Record<string, (input: Record<string, unknown>) => unknown> = {
  read_repo: (i) => ({ corpus_id: `corpus_demo_${hash(String(i.url ?? ""))}`, indexed_files: 42 }),
  search_codebase: (i) => ({
    query: i.query,
    results: [
      { path: "demo/file.ts", line: 12, snippet: "// stub: replace with Nozomio search" },
    ],
  }),
  read_file: (i) => ({ path: i.path, lines: ["// stub file body"] }),
  run_tests: () => ({ passed: 0, failed: 0, skipped: 0, note: "stub: no test runner wired" }),
  propose_pr: (i) => ({ url: "https://example.invalid/pr/0", title: i.title }),
  query_docs: (i) => ({ library: i.library, answer: "stub: docs lookup not wired" }),

  research_company: (i) => ({
    name_or_domain: i.name_or_domain,
    stage: "Series A",
    funding: "raised $20M last quarter",
    recent_news: ["launched product X", "hired CTO"],
    tech_stack: ["TypeScript", "Postgres"],
    note: "stub research data",
  }),
  find_decision_maker: (i) => ({ company: i.company, function: i.function, name: "Demo Person", title: "Head of " + String(i.function) }),
  draft_cold_email: (i) => ({ subject: "quick question", body: `Hi — saw ${i.facts}. ${String(i.angle)} angle. 15 min next week?` }),
  send_outreach: (i) => ({ thread_id: `thr_demo_${hash(String(i.to ?? ""))}`, message_id: `msg_demo_${Date.now()}` }),
  schedule_followup: () => ({ scheduled: true }),
  log_response: () => ({ logged: true }),

  source_candidates: () => ({ candidates: [{ candidate_id: "cand_demo_1", profile: "anonymized snippet" }] }),
  screen_resume: () => ({ decision: "borderline", rationale: ["stub line 1", "stub line 2", "stub line 3"] }),
  draft_outreach: () => ({ subject: "interested in your work", body: "stub outreach" }),
  schedule_interview: () => ({ event_id: `evt_demo_${Date.now()}`, time: "Tomorrow 10am PT" }),
  take_interview_notes: () => ({ saved: true }),

  search_docs: (i) => ({ question: i.question, top: ["stub doc section"] }),
  search_past_tickets: () => ({ tickets: [{ id: "t_demo", resolution: "stub resolution" }] }),
  search_logs: () => ({ events: [] }),
  status_page: () => ({ incidents: [] }),
  draft_reply: (i) => ({ body: `Acknowledgment: ${i.acknowledgment}\n\nNext step: ${i.answer_or_next_step}` }),
  send_reply: (i) => ({ sent: true, thread_id: i.thread_id }),
  escalate_to_engineer: () => ({ escalated: true, ticket_id: `tkt_demo_${Date.now()}` }),

  fetch_inbox: () => ({ items: [] }),
  search_research: () => ({ signals: [] }),
  search_specs: () => ({ specs: [] }),
  draft_spec: (i) => ({ title: i.title, body: "stub spec body" }),
  score_rice: (i) => {
    const reach = Number(i.reach ?? 0);
    const impact = Number(i.impact ?? 0);
    const confidence = Number(i.confidence ?? 0);
    const effort = Number(i.effort ?? 1) || 1;
    const score = (reach * impact * (confidence / 100)) / effort;
    return { item: i.item, score, formula: "reach * impact * (confidence/100) / effort" };
  },
  broadcast_question: () => ({ broadcast_id: `bcast_demo_${Date.now()}` }),
  synthesize_replies: () => ({ synthesis: "stub synthesis" }),
  file_ticket: (i) => ({ ticket_id: `tkt_${Date.now()}`, team: i.team }),
  add_to_backlog: (i) => ({ item_id: `bk_${Date.now()}`, title: i.title }),

  search_papers: (i) => ({ query: i.query, papers: [{ id: "paper_demo_1", title: "Stub paper", abstract: "stub abstract" }] }),
  search_web: (i) => ({ query: i.query, results: [{ url: "https://example.invalid/", snippet: "stub web result" }] }),
  read_source: (i) => ({ id: i.url_or_id, body: "stub source body" }),
  verify_source: (i) => ({ id: i.url_or_id, date: "2024-01-01", citation_count: 0 }),
  draft_brief: (i) => ({ topic: i.topic, summary: "stub brief synthesis" }),
  draft_comparison: (i) => ({ items: i.items, table: "stub comparison" }),
};

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolDispatchContext
): Promise<ToolResult> {
  // ---- CORE TOOLS — real implementations ----
  if (toolName === "log_reasoning_step") {
    const step = String(toolInput.step ?? "").trim();
    await ctx.appendStep("reasoning", step);
    return { ok: true, output: { logged: true } };
  }

  if (toolName === "update_task_status") {
    const status = String(toolInput.status ?? "");
    const note = toolInput.note ? String(toolInput.note) : undefined;
    if (
      status === "in_progress" ||
      status === "waiting_input" ||
      status === "done" ||
      status === "failed"
    ) {
      await ctx.setStatus(status, { result_summary: note });
      return { ok: true, output: { status } };
    }
    return { ok: false, output: { error: `unknown status: ${status}` } };
  }

  if (toolName === "ask_teammate") {
    // Stub: real impl would dispatch a sub-task to the named worker via
    // AgentMail and block until reply. For now we return a placeholder so
    // the loop can continue.
    return {
      ok: true,
      output: {
        from: String(toolInput.worker_role ?? "unknown"),
        reply: "stub: no teammate dispatcher wired yet",
      },
    };
  }

  if (toolName === "request_human_input") {
    const question = String(toolInput.question ?? "");
    const why = String(toolInput.why ?? "");
    await ctx.setStatus("waiting_input", {
      result_summary: `BLOCKED: ${question}\n\nWhy: ${why}`,
    });
    return {
      ok: true,
      output: { paused: true, question, why },
      endsLoop: true,
      endsLoopStatus: "waiting_input",
    };
  }

  if (toolName === "mark_task_done") {
    const summary = String(toolInput.summary ?? "");
    const status = String(toolInput.status ?? "done");
    const deliverable = toolInput.deliverable_url ? String(toolInput.deliverable_url) : undefined;
    const final =
      status === "done" || status === "partial"
        ? "done"
        : status === "refused"
          ? "refused"
          : "done";
    await ctx.setStatus(final as "done" | "refused", {
      result_summary: summary,
      deliverable_url: deliverable,
      finished: true,
    });
    await ctx.appendStep("final", summary);
    return {
      ok: true,
      output: { recorded: true, status: final },
      endsLoop: true,
      endsLoopStatus: final as LoopFinalStatus,
    };
  }

  // ---- ROLE-SPECIFIC TOOLS — stubs ----
  const stub = ROLE_STUB_RESPONSES[toolName];
  if (stub) {
    return { ok: true, output: stub(toolInput) };
  }

  return {
    ok: false,
    output: { error: `unknown tool: ${toolName}` },
  };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
