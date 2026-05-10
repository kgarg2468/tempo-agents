/**
 * Tool definitions and dispatcher for the OpenFire agent.
 *
 * The agent's evaluator is being converted from a single-shot Claude
 * call into a tool-use loop. This file declares the tool surface using
 * the Anthropic tool schema and provides a dispatcher that runs a tool
 * given a name + JSON input.
 *
 * Side-effects that need Convex `ActionCtx` are injected via `ToolDeps`
 * so this module stays runtime-independent and easy to test.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { NozomioEntityContext } from "./nozomio";

// ---------------------------------------------------------------------------
// Names — single source of truth, used by the loop and the UI.
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  "fetch_nozomio_context",
  "fetch_nozomio_source",
  "search_employee_history",
  "escalate_to_human",
  "propose_decision",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Anthropic tool schema (sent verbatim in messages.create({ tools }))
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: "fetch_nozomio_context",
    description:
      "Fetch the full Nozomio context bundle for the employee under review. Returns a summary plus an array of sources (GitHub, Jira, Slack, etc.) each with a free-form summary and structured signals. Call this first if you have not yet seen the employee's evidence.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "fetch_nozomio_source",
    description:
      "Drill into a single Nozomio source (e.g. only GitHub or only Jira). Useful when the top-level summary points at one signal and you want to verify it before deciding. Returns only sources whose `type` matches the filter (case-insensitive).",
    input_schema: {
      type: "object",
      properties: {
        source_type: {
          type: "string",
          description:
            'Source type to filter by. Examples: "github", "jira", "slack", "notion".',
        },
      },
      required: ["source_type"],
    },
  },
  {
    name: "search_employee_history",
    description:
      "Search the employee's prior decision reasonings and email thread bodies for substring matches. Returns { totalDecisionsScanned, totalMessagesScanned, hits } so you can tell 'no history exists at all' (totalDecisionsScanned=0) apart from 'history exists but query did not match' (totalDecisionsScanned>0, hits=[]). Up to 5 hits, newest first.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Substring or keyword to search for (case-insensitive).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Bail out of the decision loop and escalate to a human reviewer. Use when evidence is thin, contradictory, or sensitive (e.g. medical leave, protected class concerns). After calling this, do NOT also call propose_decision — escalation is terminal.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "1-3 sentence rationale for why a human should take over.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "propose_decision",
    description:
      "Emit the final decision. This is the only way to end the loop without escalating. Always include reasoning that cites specific signals from tools you called earlier. The emailDraft must follow the rules in the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["fire", "spare"],
          description: "Final verdict.",
        },
        reasoning: {
          type: "string",
          description:
            "3-6 sentences citing concrete signals from earlier tool calls.",
        },
        emailDraft: {
          type: "string",
          description:
            'Termination email body if decision is "fire", or short internal note if "spare". Follows the format rules in the system prompt.',
        },
      },
      required: ["decision", "reasoning", "emailDraft"],
    },
  },
];

// ---------------------------------------------------------------------------
// Dependency-injected handlers — Convex action fills these in.
// ---------------------------------------------------------------------------

export interface HistoryHit {
  decision_id: string;
  created_at: number;
  snippet: string;
  source: "reasoning" | "message";
}

export interface HistorySearchResult {
  totalDecisionsScanned: number;
  totalMessagesScanned: number;
  hits: HistoryHit[];
}

export interface ToolDeps {
  /** Lazy fetch of the employee's full Nozomio context (cached per loop). */
  getNozomioContext: () => Promise<NozomioEntityContext>;
  /** Search prior decisions + thread messages for this employee. */
  searchEmployeeHistory: (query: string) => Promise<HistorySearchResult>;
}

// ---------------------------------------------------------------------------
// Tool input/output shapes (parsed from JSON, validated lazily).
// ---------------------------------------------------------------------------

export interface ProposeDecisionInput {
  decision: "fire" | "spare";
  reasoning: string;
  emailDraft: string;
}

export interface EscalateInput {
  reason: string;
}

export interface FetchSourceInput {
  source_type: string;
}

export interface SearchHistoryInput {
  query: string;
}

export type TerminalToolResult =
  | { kind: "decision"; value: ProposeDecisionInput }
  | { kind: "escalation"; reason: string };

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface ToolRunResult {
  output: unknown;
  is_error: boolean;
  /** Set when the tool ends the loop (propose_decision or escalate_to_human). */
  terminal?: TerminalToolResult;
}

export async function runTool(
  name: string,
  rawInput: unknown,
  deps: ToolDeps,
): Promise<ToolRunResult> {
  switch (name) {
    case "fetch_nozomio_context": {
      const ctx = await deps.getNozomioContext();
      return { output: ctx, is_error: false };
    }

    case "fetch_nozomio_source": {
      const input = rawInput as FetchSourceInput | undefined;
      if (!input?.source_type || typeof input.source_type !== "string") {
        return errorOut("source_type is required and must be a string");
      }
      const ctx = await deps.getNozomioContext();
      const filter = input.source_type.toLowerCase();
      const sources = ctx.sources.filter(
        (s) => s.type.toLowerCase() === filter,
      );
      return {
        output: {
          source_type: input.source_type,
          matches: sources,
          count: sources.length,
        },
        is_error: false,
      };
    }

    case "search_employee_history": {
      const input = rawInput as SearchHistoryInput | undefined;
      if (!input?.query || typeof input.query !== "string") {
        return errorOut("query is required and must be a string");
      }
      const result = await deps.searchEmployeeHistory(input.query);
      return {
        output: { query: input.query, ...result },
        is_error: false,
      };
    }

    case "escalate_to_human": {
      const input = rawInput as EscalateInput | undefined;
      if (!input?.reason || typeof input.reason !== "string") {
        return errorOut("reason is required");
      }
      return {
        output: { escalated: true, reason: input.reason },
        is_error: false,
        terminal: { kind: "escalation", reason: input.reason },
      };
    }

    case "propose_decision": {
      const input = rawInput as Partial<ProposeDecisionInput> | undefined;
      if (
        !input ||
        (input.decision !== "fire" && input.decision !== "spare") ||
        typeof input.reasoning !== "string" ||
        typeof input.emailDraft !== "string"
      ) {
        return errorOut(
          'propose_decision requires { decision: "fire"|"spare", reasoning: string, emailDraft: string }',
        );
      }
      return {
        output: { accepted: true },
        is_error: false,
        terminal: {
          kind: "decision",
          value: {
            decision: input.decision,
            reasoning: input.reasoning,
            emailDraft: input.emailDraft,
          },
        },
      };
    }

    default:
      return errorOut(`unknown tool: ${name}`);
  }
}

function errorOut(message: string): ToolRunResult {
  return { output: { error: message }, is_error: true };
}
