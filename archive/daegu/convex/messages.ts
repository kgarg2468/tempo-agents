import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listForDecision = query({
  args: { decision_id: v.id("decisions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_decision", (q) => q.eq("decision_id", args.decision_id))
      .order("asc")
      .collect();
  },
});

// Plan alias
export const byDecision = query({
  args: { decision_id: v.id("decisions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_decision", (q) => q.eq("decision_id", args.decision_id))
      .order("asc")
      .collect();
  },
});

/**
 * Look up a message by its AgentMail-provided message id. Used as the
 * dedup guard inside the inbound webhook handler so retries are safe.
 */
export const byMessageId = query({
  args: { agentmail_message_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) =>
        q.eq("agentmail_message_id", args.agentmail_message_id)
      )
      .first();
  },
});

export const create = mutation({
  args: {
    decision_id: v.id("decisions"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    subject: v.string(),
    body: v.string(),
    from: v.string(),
    agentmail_message_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Dedupe by agentmail_message_id so retried webhooks don't double-insert.
    if (args.agentmail_message_id) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) =>
          q.eq("agentmail_message_id", args.agentmail_message_id)
        )
        .first();
      if (existing) return existing._id;
    }

    return await ctx.db.insert("messages", {
      ...args,
      created_at: Date.now(),
    });
  },
});
