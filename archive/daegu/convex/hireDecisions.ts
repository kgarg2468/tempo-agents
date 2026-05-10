import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    digital_employee_id: v.id("digital_employees"),
    reasoning: v.string(),
    onboarding_email: v.string(),
    evidence_summary: v.string(),
    agentmail_thread_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("hire_decisions", {
      ...args,
      status: "pending",
      created_at: Date.now(),
    });
  },
});

export const markSent = mutation({
  args: { id: v.id("hire_decisions") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { status: "sent" });
  },
});

export const listForDigitalEmployee = query({
  args: { digital_employee_id: v.id("digital_employees") },
  handler: async (ctx, { digital_employee_id }) => {
    return await ctx.db
      .query("hire_decisions")
      .withIndex("by_digital_employee", (q) =>
        q.eq("digital_employee_id", digital_employee_id)
      )
      .order("desc")
      .collect();
  },
});
