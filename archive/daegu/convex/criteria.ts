import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("criteria").order("desc").collect();
  },
});

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("criteria")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    weight: v.number(),
  },
  handler: async (ctx, args) => {
    // Idempotency: if a criterion with the same `name` already exists,
    // return the existing _id instead of creating a duplicate row.
    const existing = await ctx.db
      .query("criteria")
      .filter((q) => q.eq(q.field("name"), args.name))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("criteria", {
      ...args,
      active: true,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("criteria"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    weight: v.optional(v.number()),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...rest } = args;
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rest)) {
      if (val !== undefined) patch[k] = val;
    }
    await ctx.db.patch(id, patch);
  },
});

export const toggle = mutation({
  args: { id: v.id("criteria") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.id);
    if (!c) return;
    await ctx.db.patch(args.id, { active: !c.active });
  },
});

export const remove = mutation({
  args: { id: v.id("criteria") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// Plan defaults — keyed on `name` so re-seeding is a no-op.
const DEFAULTS = [
  {
    name: "Code Quality",
    description:
      "PR rejection rate. Flag when rejected PRs make up more than 40% of recent submissions.",
    weight: 2.0,
  },
  {
    name: "Deadline Adherence",
    description:
      "Missed sprint commitments. Flag when more than 30% of committed deadlines slip in a sprint.",
    weight: 2.5,
  },
  {
    name: "Communication",
    description:
      "Slack/email response cadence. Low responsiveness during incidents is a tell.",
    weight: 1.0,
  },
  {
    name: "Output Volume",
    description:
      "Commits, docs, deliverables. Output that trends to zero is a flame the manager should see.",
    weight: 1.5,
  },
];

/**
 * Idempotent seed: only inserts criteria whose `name` is missing.
 * Calling twice produces 4 rows, not 8.
 */
export const seedDefaultCriteria = mutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0;
    for (const c of DEFAULTS) {
      const existing = await ctx.db
        .query("criteria")
        .filter((q) => q.eq(q.field("name"), c.name))
        .first();
      if (!existing) {
        await ctx.db.insert("criteria", { ...c, active: true });
        inserted++;
      }
    }
    return { inserted };
  },
});
