import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("decisions").order("desc").collect();
  },
});

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("decisions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .collect();
  },
});

export const listForEmployee = query({
  args: { employee_id: v.id("employees") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("decisions")
      .withIndex("by_employee", (q) => q.eq("employee_id", args.employee_id))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("decisions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByThreadId = query({
  args: { thread_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("decisions")
      .withIndex("by_thread", (q) => q.eq("agentmail_thread_id", args.thread_id))
      .first();
  },
});

export const getActivePendingForEmployee = query({
  args: { employee_id: v.id("employees") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("decisions")
      .withIndex("by_employee", (q) => q.eq("employee_id", args.employee_id))
      .collect();
    return all.find((d) => d.status === "pending") || null;
  },
});

/**
 * Returns true if the employee has any non-rejected open decision —
 * pending, approved, or sent. Used as the idempotency guard inside the
 * fire-agent loop so we never re-evaluate someone whose fate is already
 * sealed.
 */
export const hasOpenDecision = query({
  args: { employee_id: v.id("employees") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("decisions")
      .withIndex("by_employee", (q) => q.eq("employee_id", args.employee_id))
      .collect();
    return all.some(
      (d) =>
        d.status === "pending" ||
        d.status === "approved" ||
        d.status === "sent" ||
        d.status === "escalated"
    );
  },
});

export const create = mutation({
  args: {
    employee_id: v.id("employees"),
    reasoning: v.string(),
    decision: v.union(v.literal("fire"), v.literal("spare")),
    email_draft: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotency: skip if there's already a pending decision for this employee
    const existing = await ctx.db
      .query("decisions")
      .withIndex("by_employee", (q) => q.eq("employee_id", args.employee_id))
      .collect();
    const pending = existing.find((d) => d.status === "pending");
    if (pending) return pending._id;

    const id = await ctx.db.insert("decisions", {
      ...args,
      status: "pending",
      created_at: Date.now(),
    });

    await ctx.db.patch(args.employee_id, { status: "pending" });

    return id;
  },
});

/**
 * Insert a decision in the "escalated" state. Used when the agent loop
 * calls escalate_to_human instead of propose_decision. Employee status
 * flips to "pending" so the row appears in the manager's review queue
 * with the escalation reason rather than a fire/spare verdict.
 */
export const createEscalated = mutation({
  args: {
    employee_id: v.id("employees"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("decisions")
      .withIndex("by_employee", (q) => q.eq("employee_id", args.employee_id))
      .collect();
    const open = existing.find(
      (d) => d.status === "pending" || d.status === "escalated",
    );
    if (open) return open._id;

    const id = await ctx.db.insert("decisions", {
      employee_id: args.employee_id,
      reasoning: args.reason,
      decision: "spare",
      email_draft: "",
      status: "escalated",
      escalated_reason: args.reason,
      created_at: Date.now(),
    });

    await ctx.db.patch(args.employee_id, { status: "pending" });

    return id;
  },
});

export const setStatus = mutation({
  args: {
    id: v.id("decisions"),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("sent"),
      v.literal("escalated")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const escalate = mutation({
  args: {
    id: v.id("decisions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.id);
    if (!d) throw new Error("Decision not found");
    if (d.status !== "pending") return { ok: false, reason: "not pending" };
    await ctx.db.patch(args.id, {
      status: "escalated",
      escalated_reason: args.reason,
    });
    return { ok: true };
  },
});

export const setIterations = mutation({
  args: {
    id: v.id("decisions"),
    iterations: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { iterations: args.iterations });
  },
});

export const setExitInterviewEvent = mutation({
  args: {
    id: v.id("decisions"),
    event_id: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { exit_interview_event_id: args.event_id });
  },
});

export const setThreadId = mutation({
  args: {
    id: v.id("decisions"),
    thread_id: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { agentmail_thread_id: args.thread_id });
  },
});

export const approve = mutation({
  args: { id: v.id("decisions") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.id);
    if (!d) throw new Error("Decision not found");
    if (d.status !== "pending") return { ok: false, reason: "not pending" };
    await ctx.db.patch(args.id, { status: "approved" });
    return { ok: true, decision: d };
  },
});

export const reject = mutation({
  args: { id: v.id("decisions") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.id);
    if (!d) throw new Error("Decision not found");
    if (d.status !== "pending") return { ok: false, reason: "not pending" };
    await ctx.db.patch(args.id, { status: "rejected" });
    await ctx.db.patch(d.employee_id, { status: "spared" });
    return { ok: true, decision: d };
  },
});

export const markSent = mutation({
  args: {
    id: v.id("decisions"),
    thread_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.id);
    if (!d) throw new Error("Decision not found");
    // Only flip to "sent" from a state where sending is meaningful.
    // Calling markSent on rejected/escalated/already-sent must not
    // resurrect an employee or re-send an email.
    if (d.status === "sent") return { ok: true, alreadySent: true };
    if (d.status !== "pending" && d.status !== "approved") {
      throw new Error(
        `markSent: cannot transition from ${d.status} to sent`,
      );
    }
    await ctx.db.patch(args.id, {
      status: "sent",
      ...(args.thread_id ? { agentmail_thread_id: args.thread_id } : {}),
    });
    await ctx.db.patch(d.employee_id, { status: "fired" });
    return { ok: true, alreadySent: false };
  },
});
