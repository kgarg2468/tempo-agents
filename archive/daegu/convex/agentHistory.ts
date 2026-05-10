import { query } from "./_generated/server";
import { v } from "convex/values";

const MAX_DECISIONS_SCANNED = 20;
const MAX_MESSAGES_PER_DECISION = 50;
const MAX_HITS = 5;

/**
 * History search backing the agent's `search_employee_history` tool.
 *
 * Substring match (case-insensitive) over the employee's prior decision
 * reasonings and the bodies of email messages tied to those decisions.
 * Bounded scan: at most 20 decisions × 50 messages each. The agent gets
 * back the count of what was scanned so it can distinguish "no history"
 * from "history exists but no match" — a meaningful difference for
 * consistency-checking on rehires.
 */
export const searchForEmployee = query({
  args: {
    employee_id: v.id("employees"),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const needle = args.query.trim().toLowerCase();
    if (!needle) {
      return {
        totalDecisionsScanned: 0,
        totalMessagesScanned: 0,
        hits: [],
      };
    }

    const decisions = await ctx.db
      .query("decisions")
      .withIndex("by_employee", (q) => q.eq("employee_id", args.employee_id))
      .order("desc")
      .take(MAX_DECISIONS_SCANNED);

    const hits: Array<{
      decision_id: string;
      created_at: number;
      snippet: string;
      source: "reasoning" | "message";
    }> = [];

    let totalMessagesScanned = 0;

    outer: for (const d of decisions) {
      if (d.reasoning.toLowerCase().includes(needle)) {
        hits.push({
          decision_id: d._id,
          created_at: d.created_at,
          snippet: snippet(d.reasoning, needle),
          source: "reasoning",
        });
        if (hits.length >= MAX_HITS) break;
      }

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_decision", (q) => q.eq("decision_id", d._id))
        .take(MAX_MESSAGES_PER_DECISION);

      totalMessagesScanned += messages.length;

      for (const m of messages) {
        if (m.body.toLowerCase().includes(needle)) {
          hits.push({
            decision_id: d._id,
            created_at: m.created_at,
            snippet: snippet(m.body, needle),
            source: "message",
          });
          if (hits.length >= MAX_HITS) break outer;
        }
      }
    }

    return {
      totalDecisionsScanned: decisions.length,
      totalMessagesScanned,
      hits,
    };
  },
});

function snippet(text: string, needle: string): string {
  // Match position computed against the lowercased copy, applied back to
  // the original text. For ASCII this is identical; for non-ASCII,
  // case-folding can change length and we may slice mid-grapheme. Good
  // enough for the agent's debug context but not safe for user display.
  const idx = text.toLowerCase().indexOf(needle);
  if (idx < 0) return text.slice(0, 160);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + needle.length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}
