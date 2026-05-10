import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Tool-call audit log for the agent loop.
 *
 * Each `evaluateEmployee` run can issue multiple tool calls before
 * arriving at a decision. We persist every call (input + output + timing)
 * so the dossier can replay the agent's reasoning and so we can detect
 * regressions when prompts or tools change.
 */

export const listForDecision = query({
  args: { decision_id: v.id("decisions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tool_calls")
      .withIndex("by_decision_and_iteration", (q) =>
        q.eq("decision_id", args.decision_id),
      )
      .order("asc")
      .collect();
  },
});

export const record = mutation({
  args: {
    decision_id: v.id("decisions"),
    iteration: v.number(),
    tool_name: v.string(),
    input_json: v.string(),
    output_json: v.string(),
    is_error: v.boolean(),
    duration_ms: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tool_calls", {
      ...args,
      created_at: Date.now(),
    });
  },
});

/**
 * Insert many tool_call rows in one transaction. Called once at the end
 * of the agent loop so a single decision's full trace lands atomically.
 */
export const recordBatch = mutation({
  args: {
    decision_id: v.id("decisions"),
    calls: v.array(
      v.object({
        iteration: v.number(),
        tool_name: v.string(),
        input_json: v.string(),
        output_json: v.string(),
        is_error: v.boolean(),
        duration_ms: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let inserted = 0;
    for (const call of args.calls) {
      await ctx.db.insert("tool_calls", {
        ...call,
        decision_id: args.decision_id,
        created_at: now,
      });
      inserted++;
    }
    return { inserted };
  },
});
