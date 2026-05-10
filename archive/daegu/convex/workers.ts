/**
 * Worker instance lifecycle: hire, list, fire.
 *
 * A worker is a concrete instance of a template. The template provides
 * the system prompt and tool catalog; the instance gets a name, an
 * inbox, and a status. Tasks are dispatched to instances, not templates.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const TEMPLATE_TYPE = v.union(
  v.literal("engineer"),
  v.literal("gtm"),
  v.literal("recruiter"),
  v.literal("cse"),
  v.literal("pm"),
  v.literal("researcher")
);

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("worker_instances").order("desc").collect();
  },
});

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("worker_instances")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("worker_instances") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const hire = mutation({
  args: {
    template_type: TEMPLATE_TYPE,
    name: v.string(),
    agentmail_inbox_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // The template must exist before we can hire someone against it.
    const template = await ctx.db
      .query("worker_templates")
      .withIndex("by_type", (q) => q.eq("type", args.template_type))
      .first();
    if (!template) {
      throw new Error(
        `template "${args.template_type}" not seeded; run seedWorkerTemplates first`
      );
    }
    return await ctx.db.insert("worker_instances", {
      template_type: args.template_type,
      name: args.name,
      agentmail_inbox_id: args.agentmail_inbox_id,
      status: "active",
      hired_at: Date.now(),
    });
  },
});

export const fire = mutation({
  args: { id: v.id("worker_instances") },
  handler: async (ctx, args) => {
    const w = await ctx.db.get(args.id);
    if (!w) throw new Error("worker not found");
    if (w.status === "fired") return { ok: false, reason: "already fired" };
    await ctx.db.patch(args.id, {
      status: "fired",
      fired_at: Date.now(),
    });
    return { ok: true };
  },
});
