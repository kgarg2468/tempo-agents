import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("digital_employees").order("desc").collect();
  },
});

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("digital_employees")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("digital_employees") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByInbox = query({
  args: { agentmail_address: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("digital_employees")
      .withIndex("by_inbox", (q) =>
        q.eq("agentmail_address", args.agentmail_address.toLowerCase())
      )
      .first();
  },
});

export const getOrchestrator = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("digital_employees")
      .withIndex("by_orchestrator", (q) => q.eq("is_orchestrator", true))
      .first();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    role: v.string(),
    replaces_employee_id: v.optional(v.id("employees")),
    nozomio_entity_id: v.string(),
    agentmail_inbox_id: v.string(),
    agentmail_address: v.string(),
    a2a_endpoint_url: v.string(),
    a2a_card: v.any(),
    skills: v.array(v.string()),
    is_orchestrator: v.boolean(),
    sources_indexed: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("digital_employees")
      .withIndex("by_inbox", (q) =>
        q.eq("agentmail_address", args.agentmail_address.toLowerCase())
      )
      .first();
    if (existing) return existing._id;
    const now = Date.now();
    return await ctx.db.insert("digital_employees", {
      name: args.name,
      role: args.role,
      replaces_employee_id: args.replaces_employee_id,
      nozomio_entity_id: args.nozomio_entity_id,
      agentmail_inbox_id: args.agentmail_inbox_id,
      agentmail_address: args.agentmail_address.toLowerCase(),
      a2a_endpoint_url: args.a2a_endpoint_url,
      a2a_card: args.a2a_card,
      skills: args.skills,
      is_orchestrator: args.is_orchestrator,
      status: "active",
      knowledge_stats: {
        sources_indexed: args.sources_indexed,
        last_indexed_at: now,
      },
      created_at: now,
    });
  },
});

export const setStatus = mutation({
  args: {
    id: v.id("digital_employees"),
    status: v.union(
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("retired")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const updateKnowledgeStats = mutation({
  args: {
    id: v.id("digital_employees"),
    sources_indexed: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      knowledge_stats: {
        sources_indexed: args.sources_indexed,
        last_indexed_at: Date.now(),
      },
    });
  },
});
