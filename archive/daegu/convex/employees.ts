import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("employees").order("desc").collect();
  },
});

export const listByStatus = query({
  args: {
    status: v.union(
      v.literal("active"),
      v.literal("pending"),
      v.literal("fired"),
      v.literal("spared")
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("employees")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("employees") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    role: v.string(),
    nozomio_entity_id: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotency: if an employee with this email already exists, return
    // the existing _id instead of creating a duplicate.
    const existing = await ctx.db
      .query("employees")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("employees", {
      ...args,
      status: "active",
      created_at: Date.now(),
    });
  },
});

export const setStatus = mutation({
  args: {
    id: v.id("employees"),
    status: v.union(
      v.literal("active"),
      v.literal("pending"),
      v.literal("fired"),
      v.literal("spared")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const remove = mutation({
  args: { id: v.id("employees") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
