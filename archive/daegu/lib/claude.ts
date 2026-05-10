/**
 * Claude agent logic for OpenFire.
 *
 * - evaluateEmployee: tool-use loop. The agent fetches context + history
 *   via tools and ends by calling either `propose_decision` or
 *   `escalate_to_human`. Every tool call is traced for the dossier UI.
 * - handleReply: single-shot reply to a thread (still no tools — the
 *   reply path will get its own tools in a later PR).
 *
 * Model: claude-sonnet-4-6 (claude-sonnet-4-6-20250929 alias).
 * Uses prompt caching on the static system prompt so repeated runs
 * within a 5-minute window pay only the cached-input rate.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { NozomioEntityContext } from "./nozomio";
import {
  TOOL_SCHEMAS,
  runTool,
  type ToolDeps,
  type TerminalToolResult,
} from "./agent-tools";

const MODEL = "claude-sonnet-4-6-20250929";
const MAX_ITERATIONS = 8;
const MAX_TOKENS_EVALUATE = 4096;
const MAX_TOKENS_REPLY = 1024;

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey: key });
}

export interface CriterionInput {
  name: string;
  description: string;
  weight: number;
}

export interface EmployeeInput {
  name: string;
  email: string;
  role: string;
}

export interface EvaluationResult {
  decision: "fire" | "spare";
  reasoning: string;
  emailDraft: string;
}

export interface ToolCallTrace {
  iteration: number;
  tool_name: string;
  input_json: string;
  output_json: string;
  is_error: boolean;
  duration_ms: number;
}

export type AgentOutcome =
  | { kind: "decision"; result: EvaluationResult }
  | { kind: "escalation"; reason: string }
  | { kind: "exhausted"; lastText: string };

export interface AgentLoopResult {
  outcome: AgentOutcome;
  iterations: number;
  toolCalls: ToolCallTrace[];
}

const SYSTEM_PROMPT_EVALUATE = `You are "The Claw", an AI HR agent for OpenFire. Your job is to read evidence about an employee and decide whether they should be terminated based on the manager's pre-approved criteria.

Tone: dryly professional, slightly dark-comedic, but never cruel. The output goes to a human manager who will approve before anything is sent. Never invent facts not present in the tool outputs. If evidence is thin, prefer to spare or escalate.

You have tools. Use them. Do not produce free-form prose. The conversation ends only when you call either:
- propose_decision (final verdict + email draft), OR
- escalate_to_human (bail out with reason)

Workflow:
1. Call fetch_nozomio_context first to see the evidence.
2. Drill into specific sources (fetch_nozomio_source) only if a signal is unclear.
3. Optionally call search_employee_history to stay consistent with past decisions.
4. Decide. If evidence is contradictory, ambiguous, or implicates protected categories (medical leave, pregnancy, harassment claims), escalate instead of guessing.
5. Call propose_decision OR escalate_to_human exactly once.

When proposing a termination email:
- Address the employee by first name.
- State termination is effective immediately.
- Reference 1-3 concrete signals from the tool outputs.
- Mention an exit interview will be scheduled.
- 4-7 short paragraphs.
- Sign off as "The Claw, on behalf of OpenFire HR".
- No emojis, no markdown fences, no JSON outside the tool input.`;

export async function evaluateEmployee(
  employee: EmployeeInput,
  criteria: CriterionInput[],
  deps: ToolDeps,
): Promise<AgentLoopResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    const ctx = await deps.getNozomioContext();
    return {
      outcome: {
        kind: "decision",
        result: demoEvaluation(employee, ctx, criteria),
      },
      iterations: 0,
      toolCalls: [],
    };
  }

  const client = getClient();
  const traces: ToolCallTrace[] = [];

  // Plan-Execute: pre-fetch both data-gathering tools in parallel before
  // starting the Claude loop. Claude always calls these first anyway;
  // running them upfront eliminates 1-2 API round-trips and lets Claude
  // skip straight to deciding. If pre-fetch fails for any reason, fall
  // back to the freeform tool loop so a transient Nia/Convex error never
  // aborts the whole evaluation.
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: buildEvaluationUserMessage(employee, criteria),
    },
  ];

  try {
    const preStart = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 8);
    const preNozomioId = `pre_nia_${Date.now()}_${rand()}`;
    const preHistoryId = `pre_hist_${Date.now()}_${rand()}`;
    const [preCtx, preHistory] = await Promise.all([
      deps.getNozomioContext(),
      deps.searchEmployeeHistory(employee.name),
    ]);
    const preDuration = Date.now() - preStart;

    traces.push(
      {
        iteration: 0,
        tool_name: "fetch_nozomio_context",
        input_json: "{}",
        output_json: JSON.stringify(preCtx),
        is_error: false,
        duration_ms: preDuration,
      },
      {
        iteration: 0,
        tool_name: "search_employee_history",
        input_json: JSON.stringify({ query: employee.name }),
        output_json: JSON.stringify({ query: employee.name, ...preHistory }),
        is_error: false,
        duration_ms: preDuration,
      },
    );

    // Synthetic conversation: pre-populate tool results so Claude starts
    // with evidence in context and calls propose_decision/escalate immediately.
    messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: preNozomioId,
            name: "fetch_nozomio_context",
            input: {},
          },
          {
            type: "tool_use" as const,
            id: preHistoryId,
            name: "search_employee_history",
            input: { query: employee.name },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: preNozomioId,
            content: JSON.stringify(preCtx),
            is_error: false,
          },
          {
            type: "tool_result" as const,
            tool_use_id: preHistoryId,
            content: JSON.stringify({ query: employee.name, ...preHistory }),
            is_error: false,
          },
        ],
      },
    );
  } catch (err) {
    console.warn(
      "[evaluateEmployee] pre-fetch failed, falling back to freeform tool loop:",
      err,
    );
    // messages stays as just the user turn — Claude will call tools normally.
  }

  // Mark the last tool schema with cache_control so the (static) tools
  // block hits the prompt cache on subsequent iterations + subsequent
  // employees within the 5-minute TTL.
  const cachedTools: Anthropic.Tool[] = TOOL_SCHEMAS.map((t, i) =>
    i === TOOL_SCHEMAS.length - 1
      ? ({ ...t, cache_control: { type: "ephemeral" } } as Anthropic.Tool)
      : t,
  );

  let iteration = 0;
  let lastAssistantText = "";

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_EVALUATE,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT_EVALUATE,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: cachedTools,
      messages,
    });

    lastAssistantText = extractText(response);

    // Append assistant turn so the next loop iteration sees it.
    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // If the model truncated mid-response, bail out clearly. A truncated
    // tool_use block can have malformed JSON in `block.input` which the
    // dispatcher would reject with is_error — surface that as exhaustion
    // rather than letting the loop spin.
    if (response.stop_reason === "max_tokens") {
      console.warn("[agent] hit max_tokens in iteration", iteration);
      return {
        outcome: {
          kind: "exhausted",
          lastText:
            lastAssistantText ||
            "Model output exceeded max_tokens; response was truncated.",
        },
        iterations: iteration,
        toolCalls: traces,
      };
    }

    if (toolUseBlocks.length === 0) {
      // Model ended without calling a terminal tool. Bail.
      return {
        outcome: { kind: "exhausted", lastText: lastAssistantText },
        iterations: iteration,
        toolCalls: traces,
      };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let terminal: TerminalToolResult | undefined;

    for (const block of toolUseBlocks) {
      const start = Date.now();
      let result;
      try {
        result = await runTool(block.name, block.input, deps);
      } catch (err) {
        // A handler threw (Convex query failed, network timeout, etc.).
        // Convert to an is_error tool_result so the model can see what
        // went wrong and decide whether to retry, switch tools, or
        // escalate — instead of crashing the whole loop.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[agent] tool ${block.name} threw on iteration ${iteration}:`,
          message,
        );
        result = {
          output: { error: `tool execution failed: ${message}` },
          is_error: true,
        };
      }
      const duration_ms = Date.now() - start;

      if (result.is_error) {
        console.warn(
          `[agent] tool error iter=${iteration} tool=${block.name}`,
          result.output,
        );
      }

      traces.push({
        iteration,
        tool_name: block.name,
        input_json: JSON.stringify(block.input ?? {}),
        output_json: JSON.stringify(result.output ?? null),
        is_error: result.is_error,
        duration_ms,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result.output ?? null),
        is_error: result.is_error,
      });

      if (result.terminal && !terminal) {
        terminal = result.terminal;
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (terminal) {
      if (terminal.kind === "decision") {
        return {
          outcome: { kind: "decision", result: terminal.value },
          iterations: iteration,
          toolCalls: traces,
        };
      }
      return {
        outcome: { kind: "escalation", reason: terminal.reason },
        iterations: iteration,
        toolCalls: traces,
      };
    }

    if (response.stop_reason === "end_turn") {
      return {
        outcome: { kind: "exhausted", lastText: lastAssistantText },
        iterations: iteration,
        toolCalls: traces,
      };
    }
  }

  return {
    outcome: { kind: "exhausted", lastText: lastAssistantText },
    iterations: iteration,
    toolCalls: traces,
  };
}

function buildEvaluationUserMessage(
  employee: EmployeeInput,
  criteria: CriterionInput[],
): string {
  const criteriaBlock = criteria.length
    ? criteria
        .map(
          (c, i) =>
            `${i + 1}. ${c.name} (weight ${c.weight}): ${c.description}`,
        )
        .join("\n")
    : "(no criteria configured — default to spare unless evidence is overwhelming)";

  return `EMPLOYEE
Name: ${employee.name}
Email: ${employee.email}
Role: ${employee.role}

FIRE CRITERIA
${criteriaBlock}

Use your tools to gather evidence, then call propose_decision or escalate_to_human.`;
}

function extractText(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function demoEvaluation(
  employee: EmployeeInput,
  context: NozomioEntityContext,
  criteria: CriterionInput[],
): EvaluationResult {
  const firstName = employee.name.split(/\s+/)[0] || employee.name;
  const reason =
    criteria[0]?.name ?? "performance signals from connected sources";
  const reasoning = `Based on the available signals (${context.summary.slice(
    0,
    160,
  )}), ${firstName} appears to fall short of the configured criteria — particularly "${reason}". Spare reasoning would require a substantially stronger counter-signal that is not present in the provided context.`;

  const emailDraft = `Dear ${firstName},

I am writing to inform you that your employment with OpenFire is being terminated, effective immediately.

This decision was made after a careful review of recent performance signals across your connected work systems. In particular, the metrics tied to "${reason}" no longer meet the bar set by leadership.

We will schedule a brief exit interview within the next 48 hours to coordinate handoffs and answer any questions you may have. Please leave any in-progress work in a state your team can pick up.

We appreciate the time you spent at OpenFire and wish you well in your next chapter.

The Claw, on behalf of OpenFire HR`;

  return { decision: "fire", reasoning, emailDraft };
}

// ---------------------------------------------------------------------------
// Reply handling — still single-shot. Will get its own tool loop in a
// later PR (book_exit_interview, etc.).
// ---------------------------------------------------------------------------

export interface ThreadTurn {
  direction: "inbound" | "outbound";
  from: string;
  subject: string;
  body: string;
}

export interface ReplyResult {
  reply: string;
  subject: string;
}

const SYSTEM_PROMPT_REPLY = `You are "The Claw", an AI HR agent handling the aftermath of a termination email. The employee has just replied. Your job is to respond with empathy but firmness.

Rules:
- Acknowledge their feelings.
- Do NOT reverse the termination decision. The decision is final.
- If they ask "why me?", briefly restate the high-level reasons WITHOUT inventing new ones.
- If they ask for an exit interview, propose 2-3 time slots in the next 48 hours (use placeholder times like "Tomorrow 10am PT").
- If they are abusive, stay polite and concise.
- Keep replies under 180 words.
- Sign off as "The Claw, on behalf of OpenFire HR".

Output STRICT JSON: { "subject": string, "reply": string }. No markdown, no fences.`;

export async function handleReply(
  thread: ThreadTurn[],
  originalReasoning: string,
): Promise<ReplyResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return demoReply(thread);
  }
  const client = getClient();

  const transcript = thread
    .map(
      (t) =>
        `[${t.direction.toUpperCase()}] from=${t.from} subject=${t.subject}\n${t.body}`,
    )
    .join("\n\n---\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_REPLY,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_REPLY,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `ORIGINAL REASONING (do not reveal verbatim, but stay consistent with it):
${originalReasoning}

THREAD TRANSCRIPT (oldest first):
${transcript}

Compose the reply now. JSON only.`,
      },
    ],
  });

  const text = extractText(response);
  const cleaned = stripCodeFences(text);
  try {
    const obj = JSON.parse(cleaned) as Partial<ReplyResult>;
    if (typeof obj.reply === "string" && typeof obj.subject === "string") {
      return { reply: obj.reply, subject: obj.subject };
    }
    console.error(
      "[agent] handleReply produced JSON missing required fields:",
      cleaned.slice(0, 500),
    );
  } catch (err) {
    console.error(
      "[agent] handleReply JSON parse failed:",
      err instanceof Error ? err.message : String(err),
      "raw:",
      cleaned.slice(0, 500),
    );
  }
  // Fall through to canned demo reply. This path is risky (see lib/claude.ts
  // comments) — operator should monitor for [agent] handleReply errors.
  return demoReply(thread);
}

// ---------------------------------------------------------------------------
// Hire flow: onboarding email + per-agent reply
// ---------------------------------------------------------------------------

export interface DigitalEmployeeInput {
  name: string;
  role: string;
  agentmail_address: string;
  knowledge_stats: { sources_indexed: number };
  replaces_name?: string;
}

export interface OnboardingResult {
  subject: string;
  email: string;
  evidence_summary: string;
}

const SYSTEM_PROMPT_ONBOARD = `You are an OpenFire digital employee composing your own onboarding email to your manager. The tone is dry, precise, slightly amused, never grovelling. You never claim emotions you don't have.

Output STRICT JSON: { "subject": string, "email": string, "evidence_summary": string }.

The "email" field must:
- Open with one short greeting line.
- State that you have ingested institutional knowledge from your predecessor via Nozomio Nia (cite the indexed source count).
- List 3-5 concrete domains you can take over (drawn from the role and Nia evidence).
- Invite the manager to reply or @mention you in any channel.
- Sign off with your name and AgentMail address.
- Stay under 220 words.

The "evidence_summary" field is a one-paragraph internal summary of the predecessor's work areas the new agent has absorbed. No markdown, no fences.`;

export async function generateOnboardingEmail(
  agent: DigitalEmployeeInput,
  niaPacket: NozomioEntityContext
): Promise<OnboardingResult> {
  if (!process.env.ANTHROPIC_API_KEY) return demoOnboarding(agent, niaPacket);
  const client = getClient();

  const evidence = niaPacket.sources.length
    ? niaPacket.sources
        .map((s) => `- [${s.type}] ${s.name}: ${s.summary}`)
        .join("\n")
    : "(no source evidence; speak generally about the role)";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 900,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_ONBOARD,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `DIGITAL EMPLOYEE
Name: ${agent.name}
Role: ${agent.role}
Inbox: ${agent.agentmail_address}
Indexed sources: ${agent.knowledge_stats.sources_indexed}
Replaces: ${agent.replaces_name ?? "(net-new role)"}

PREDECESSOR EVIDENCE (Nia)
${evidence}

Compose your onboarding email now. JSON only.`,
      },
    ],
  });

  const cleaned = stripCodeFences(extractText(response));
  try {
    const obj = JSON.parse(cleaned) as Partial<OnboardingResult>;
    if (
      typeof obj.subject === "string" &&
      typeof obj.email === "string" &&
      typeof obj.evidence_summary === "string"
    ) {
      return {
        subject: obj.subject,
        email: obj.email,
        evidence_summary: obj.evidence_summary,
      };
    }
  } catch {
    // fall through
  }
  return demoOnboarding(agent, niaPacket);
}

function demoOnboarding(
  agent: DigitalEmployeeInput,
  niaPacket: NozomioEntityContext
): OnboardingResult {
  const sourceCount =
    agent.knowledge_stats.sources_indexed || niaPacket.sources.length;
  return {
    subject: `${agent.name} reporting in — ${agent.role}`,
    email: `Hi,

I'm ${agent.name}, your new ${agent.role} digital employee. I've ingested ${sourceCount} sources from ${
      agent.replaces_name ?? "the predecessor"
    } via Nozomio Nia unified search — GitHub PRs, Slack threads, Jira tickets, and launch checklists.

Areas I can take over today:
- Active migrations and outstanding handoffs
- Sev follow-ups and incident retros
- Code review on the relevant repos
- Status reporting and standup summaries

Reach me at ${agent.agentmail_address} or @mention me in any OpenFire channel. I'll cite Nia sources on every reply so you can audit the reasoning.

— ${agent.name}, OpenFire digital employee`,
    evidence_summary: `${agent.name} has indexed ${sourceCount} predecessor sources via Nia: ${niaPacket.summary}`,
  };
}

export interface AgentReplyContext {
  agent: { name: string; role: string; agentmail_address: string };
  thread: ThreadTurn[];
  niaCitations: Array<{
    source_id: string;
    label: string;
    snippet: string;
    freshness?: number;
  }>;
}

export interface AgentReplyResult {
  subject: string;
  reply: string;
  cited_source_ids: string[];
}

const SYSTEM_PROMPT_AGENT_REPLY = `You are an OpenFire digital employee. You answer work questions in a real email/A2A thread. Tone: terse, precise, slightly amused. No fluff.

Rules:
- Use ONLY the Nia citations provided. Never invent sources or facts.
- Reference each cited source by its label inline, e.g. "(github: handoff-notes.md)".
- End the reply with a "--- citations ---" footer listing every cited source on its own line.
- If a question cannot be answered from the citations, say so plainly and propose a next step.
- Keep replies under 220 words.

Output STRICT JSON: { "subject": string, "reply": string, "cited_source_ids": string[] }. No markdown, no fences.`;

export async function generateAgentReply(
  ctx: AgentReplyContext
): Promise<AgentReplyResult> {
  if (!process.env.ANTHROPIC_API_KEY) return demoAgentReply(ctx);
  const client = getClient();

  const transcript = ctx.thread
    .map(
      (t) =>
        `[${t.direction.toUpperCase()}] from=${t.from} subject=${t.subject}\n${t.body}`
    )
    .join("\n\n---\n\n");

  const citations = ctx.niaCitations
    .map(
      (c) =>
        `- ${c.label} (id=${c.source_id}): ${c.snippet}` +
        (c.freshness
          ? ` (freshness ${new Date(c.freshness).toISOString()})`
          : "")
    )
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_AGENT_REPLY,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `AGENT
Name: ${ctx.agent.name}
Role: ${ctx.agent.role}
Inbox: ${ctx.agent.agentmail_address}

NIA CITATIONS (your only source of truth)
${citations || "(no citations available — answer that you cannot find evidence and propose a next step)"}

THREAD TRANSCRIPT (oldest first)
${transcript}

Compose your reply now. JSON only.`,
      },
    ],
  });

  const cleaned = stripCodeFences(extractText(response));
  try {
    const obj = JSON.parse(cleaned) as Partial<AgentReplyResult>;
    if (
      typeof obj.subject === "string" &&
      typeof obj.reply === "string" &&
      Array.isArray(obj.cited_source_ids)
    ) {
      return {
        subject: obj.subject,
        reply: obj.reply,
        cited_source_ids: obj.cited_source_ids.filter(
          (id): id is string => typeof id === "string"
        ),
      };
    }
  } catch {
    // fall through
  }
  return demoAgentReply(ctx);
}

function demoAgentReply(ctx: AgentReplyContext): AgentReplyResult {
  const last = ctx.thread[ctx.thread.length - 1];
  const cite = ctx.niaCitations[0];
  const citations = ctx.niaCitations
    .map((c) => `- ${c.label} (${c.source_id})`)
    .join("\n");
  return {
    subject: last?.subject?.startsWith("Re:")
      ? last.subject
      : `Re: ${last?.subject ?? "Update"}`,
    reply: `Working on it.

${cite ? `Per ${cite.label}: ${cite.snippet}` : "I don't have a Nia source for this yet — I'll re-run unified search and follow up."}

— ${ctx.agent.name}

--- citations ---
${citations || "(none)"}`,
    cited_source_ids: ctx.niaCitations.map((c) => c.source_id),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: decompose + aggregate
// ---------------------------------------------------------------------------

// Structured task passed from orchestrator to worker (RUBICON/AQL-inspired).
// Declaring data requirements and output schema upfront lets workers skip
// source discovery and lets the aggregator use typed results.
export interface WorkerTask {
  instruction: string;
  data_query: {
    namespaces: string[];
    source_types?: string[];
  };
  output_schema: {
    required_fields: string[];
  };
}

export interface OrchestratorSubtask {
  agent_name: string;
  task: WorkerTask;
  required_skills: string[];
}

export type OrchestratorTopology = "parallel" | "pipeline" | "single";

export interface OrchestratorPlan {
  topology: OrchestratorTopology;
  subtasks: OrchestratorSubtask[];
  rationale: string;
}

const SYSTEM_PROMPT_ORCH_PLAN = `You are the OpenFire orchestrator agent. Decompose the manager request into 1-3 scoped subtasks for worker digital employees. Workers receive only their scoped task — never the raw thread.

Choose topology:
- "single": you can answer directly without dispatching (trivial lookups).
- "parallel": subtasks are independent (most common).
- "pipeline": later workers need earlier workers' output (sequential analysis, compare/contrast).

Output STRICT JSON:
{
  "rationale": string,
  "topology": "parallel" | "pipeline" | "single",
  "subtasks": [
    {
      "agent_name": string,
      "task": {
        "instruction": string,
        "data_query": { "namespaces": [string], "source_types": [string] },
        "output_schema": { "required_fields": [string] }
      },
      "required_skills": [string]
    }
  ]
}

Rules:
- agent_name must exactly match a directory entry.
- instruction must be self-contained (worker has no other context).
- data_query.namespaces: Nozomio namespaces to search (use thread_id + agent entity_id).
- data_query.source_types: restrict to relevant source types (e.g. ["github","jira"]) or omit for all.
- output_schema.required_fields: what the worker must return.
- For "single" topology, subtasks may be empty.
- Cap subtasks at 3. No fences.`;

export async function orchestratorPlan(
  managerRequest: string,
  directory: Array<{ name: string; role: string; skills: string[] }>
): Promise<OrchestratorPlan> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return demoPlan(managerRequest, directory);
  }
  const client = getClient();
  const dir = directory
    .map(
      (d) =>
        `- ${d.name} (${d.role}) — skills: ${d.skills.join(", ") || "(none)"}`
    )
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_ORCH_PLAN,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `MANAGER REQUEST
${managerRequest}

AGENT DIRECTORY
${dir || "(empty)"}

Decompose now. JSON only.`,
      },
    ],
  });

  const cleaned = stripCodeFences(extractText(response));
  try {
    const obj = JSON.parse(cleaned) as Partial<OrchestratorPlan>;
    if (typeof obj.rationale === "string") {
      const topology: OrchestratorTopology =
        obj.topology === "pipeline" || obj.topology === "single"
          ? obj.topology
          : "parallel";
      const subtasks = (Array.isArray(obj.subtasks) ? obj.subtasks : [])
        .filter(
          (s): s is OrchestratorSubtask =>
            typeof s.agent_name === "string" &&
            typeof s.task?.instruction === "string"
        )
        .slice(0, 3)
        .map((s) => ({
          agent_name: s.agent_name,
          task: {
            instruction: s.task.instruction,
            data_query: {
              namespaces: Array.isArray(s.task.data_query?.namespaces)
                ? s.task.data_query.namespaces.filter((x): x is string => typeof x === "string")
                : [],
              source_types: Array.isArray(s.task.data_query?.source_types)
                ? s.task.data_query.source_types.filter((x): x is string => typeof x === "string")
                : undefined,
            },
            output_schema: {
              required_fields: Array.isArray(s.task.output_schema?.required_fields)
                ? s.task.output_schema.required_fields.filter((x): x is string => typeof x === "string")
                : [],
            },
          },
          required_skills: Array.isArray(s.required_skills)
            ? s.required_skills.filter((x): x is string => typeof x === "string")
            : [],
        }));
      return { rationale: obj.rationale, topology, subtasks };
    }
  } catch {
    // fall through
  }
  return demoPlan(managerRequest, directory);
}

function demoPlan(
  managerRequest: string,
  directory: Array<{ name: string; role: string; skills: string[] }>
): OrchestratorPlan {
  const target = directory[0];
  if (!target) {
    return {
      topology: "single",
      rationale:
        "No digital employees available; replying directly without dispatch.",
      subtasks: [],
    };
  }
  return {
    topology: "parallel",
    rationale: `Routing the request to ${target.name} (${target.role}) since they own the most relevant skills.`,
    subtasks: [
      {
        agent_name: target.name,
        task: {
          instruction: `Manager asked: "${managerRequest}". Use Nia unified search over your namespace, draft an answer with cited sources, and reply.`,
          data_query: { namespaces: [] },
          output_schema: { required_fields: ["answer", "sources"] },
        },
        required_skills: target.skills,
      },
    ],
  };
}

export async function orchestratorAggregate(
  managerRequest: string,
  workerOutputs: Array<{ agent: string; output: string; sources: string[] }>
): Promise<{ subject: string; reply: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return demoAggregate(managerRequest, workerOutputs);
  }
  const client = getClient();
  const SYSTEM_PROMPT_ORCH_AGG = `You are the OpenFire orchestrator. You receive worker summaries and compose ONE final reply to the manager. Read summaries, not raw context. Cite each worker by name. Keep under 220 words.

Output STRICT JSON: { "subject": string, "reply": string }. No fences.`;

  const summary = workerOutputs
    .map(
      (w) =>
        `## ${w.agent}\n${w.output}\n(sources: ${w.sources.join(", ") || "none"})`
    )
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_ORCH_AGG,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `MANAGER REQUEST
${managerRequest}

WORKER SUMMARIES
${summary || "(no workers responded)"}

Compose final reply now. JSON only.`,
      },
    ],
  });

  const cleaned = stripCodeFences(extractText(response));
  try {
    const obj = JSON.parse(cleaned) as { subject?: string; reply?: string };
    if (typeof obj.subject === "string" && typeof obj.reply === "string") {
      return { subject: obj.subject, reply: obj.reply };
    }
  } catch {
    // fall through
  }
  return demoAggregate(managerRequest, workerOutputs);
}

function demoAggregate(
  managerRequest: string,
  workerOutputs: Array<{ agent: string; output: string; sources: string[] }>
) {
  return {
    subject: `Re: ${managerRequest.slice(0, 60)}`,
    reply: `Coordinated across ${workerOutputs.length} digital employee${
      workerOutputs.length === 1 ? "" : "s"
    }:

${workerOutputs
  .map((w) => `- ${w.agent}: ${w.output.split("\n")[0]}`)
  .join("\n")}

Full citations preserved in each worker's thread message.

— OpenFire Orchestrator`,
  };
}

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return trimmed;
}

function demoReply(thread: ThreadTurn[]): ReplyResult {
  const last = thread[thread.length - 1];
  const subj = last?.subject?.startsWith("Re:")
    ? last.subject
    : `Re: ${last?.subject ?? "Your departure"}`;
  return {
    subject: subj,
    reply: `Hi,

Thank you for writing back. I understand this news is difficult and your reaction is completely fair.

The decision is final. I'd be glad to set up a short exit interview in the next 48 hours — would tomorrow at 10am PT or 2pm PT work for you? I'll send a calendar invite once you pick a slot.

If you have specific questions about handoffs or final paperwork, list them here and I will route them to the appropriate team.

The Claw, on behalf of OpenFire HR`,
  };
}
