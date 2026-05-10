/**
 * Worker task storage. Tasks are dispatched to a worker instance via
 * the `workerRunner.dispatchTask` action; this module owns the task
 * row plus the per-turn deliberation log (`worker_task_steps`).
 *
 * Steps are append-only: every reasoning/tool-call/tool-result/final
 * event the loop emits becomes one row, in order, indexed by task.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const TASK_STATUS = v.union(
  v.literal("pending"),
  v.literal("in_progress"),
  v.literal("waiting_input"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("refused")
);

const STEP_KIND = v.union(
  v.literal("reasoning"),
  v.literal("tool_call"),
  v.literal("tool_result"),
  v.literal("final")
);

export const get = query({
  args: { id: v.id("worker_tasks") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

export const listForWorker = query({
  args: { worker_id: v.id("worker_instances") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("worker_tasks")
      .withIndex("by_worker", (q) => q.eq("worker_id", args.worker_id))
      .order("desc")
      .collect();
  },
});

export const listSteps = query({
  args: { task_id: v.id("worker_tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("worker_task_steps")
      .withIndex("by_task", (q) => q.eq("task_id", args.task_id))
      .order("asc")
      .collect();
  },
});

export const create = mutation({
  args: {
    worker_id: v.id("worker_instances"),
    brief: v.string(),
    agentmail_thread_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("worker_tasks", {
      worker_id: args.worker_id,
      brief: args.brief,
      agentmail_thread_id: args.agentmail_thread_id,
      status: "pending",
      created_at: Date.now(),
    });
  },
});

export const setStatus = mutation({
  args: {
    id: v.id("worker_tasks"),
    status: TASK_STATUS,
    result_summary: v.optional(v.string()),
    deliverable_url: v.optional(v.string()),
    error: v.optional(v.string()),
    finished: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status };
    if (args.result_summary !== undefined) patch.result_summary = args.result_summary;
    if (args.deliverable_url !== undefined) patch.deliverable_url = args.deliverable_url;
    if (args.error !== undefined) patch.error = args.error;
    if (args.finished) patch.finished_at = Date.now();
    await ctx.db.patch(args.id, patch);
  },
});

export const addStep = mutation({
  args: {
    task_id: v.id("worker_tasks"),
    turn: v.number(),
    kind: STEP_KIND,
    content: v.string(),
    tool_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("worker_task_steps", {
      ...args,
      created_at: Date.now(),
    });
  },
});
