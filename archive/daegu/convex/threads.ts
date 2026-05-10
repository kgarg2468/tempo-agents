import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

const citationValidator = v.object({
  source_id: v.string(),
  label: v.string(),
  freshness: v.optional(v.number()),
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("threads").order("desc").collect();
  },
});

export const get = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    return await ctx.db
      .query("threads")
      .withIndex("by_thread_id", (q) => q.eq("thread_id", thread_id))
      .first();
  },
});

export const messagesForThread = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    return await ctx.db
      .query("thread_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("asc")
      .collect();
  },
});

export const messageByExternalId = query({
  args: { external_id: v.string() },
  handler: async (ctx, { external_id }) => {
    return await ctx.db
      .query("thread_messages")
      .withIndex("by_external_id", (q) => q.eq("external_id", external_id))
      .first();
  },
});

export const ensureThread = mutation({
  args: {
    thread_id: v.string(),
    title: v.string(),
    participants: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("threads")
      .withIndex("by_thread_id", (q) => q.eq("thread_id", args.thread_id))
      .first();
    if (existing) {
      // merge participants
      const merged = Array.from(
        new Set([...existing.participants, ...args.participants])
      );
      if (merged.length !== existing.participants.length) {
        await ctx.db.patch(existing._id, { participants: merged });
      }
      return existing._id;
    }
    return await ctx.db.insert("threads", {
      thread_id: args.thread_id,
      title: args.title,
      participants: args.participants,
      nia_namespace: args.thread_id,
      status: "open",
      created_at: Date.now(),
    });
  },
});

export const setStatus = mutation({
  args: {
    thread_id: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("paused"),
      v.literal("closed")
    ),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db
      .query("threads")
      .withIndex("by_thread_id", (q) => q.eq("thread_id", args.thread_id))
      .first();
    if (t) await ctx.db.patch(t._id, { status: args.status });
  },
});

export const insertMessage = mutation({
  args: {
    thread_id: v.string(),
    transport: v.union(v.literal("email"), v.literal("a2a")),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    sender: v.string(),
    recipients: v.array(v.string()),
    subject: v.optional(v.string()),
    body: v.string(),
    citations: v.array(citationValidator),
    external_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.external_id) {
      const dup = await ctx.db
        .query("thread_messages")
        .withIndex("by_external_id", (q) =>
          q.eq("external_id", args.external_id!)
        )
        .first();
      if (dup) return dup._id;
    }
    return await ctx.db.insert("thread_messages", {
      ...args,
      created_at: Date.now(),
    });
  },
});

/**
 * Append a message to a thread AND auto-index it into the thread's Nia
 * namespace so future agent replies can retrieve prior turns. Per the
 * orchestrator-worker pattern, agents never carry the raw thread — they
 * unifiedSearch over the namespace per turn.
 */
export const appendAndIndex = action({
  args: {
    thread_id: v.string(),
    transport: v.union(v.literal("email"), v.literal("a2a")),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    sender: v.string(),
    recipients: v.array(v.string()),
    subject: v.optional(v.string()),
    body: v.string(),
    citations: v.array(citationValidator),
    external_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.threads.insertMessage, args);

    try {
      const { ingestSourcesForEntity } = await import("../lib/nozomio");
      await ingestSourcesForEntity(args.thread_id, [
        {
          type: args.transport,
          name: `${args.sender} → ${args.recipients.join(", ")} ${
            args.subject ?? ""
          }`.trim(),
          body: args.body,
          metadata: {
            direction: args.direction,
            external_id: args.external_id,
          },
        },
      ]);
    } catch (err) {
      console.warn("[threads.appendAndIndex] Nia ingest skipped:", err);
    }

    return { ok: true };
  },
});
