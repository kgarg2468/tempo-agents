/**
 * Worker template registry. Holds the six Iron Claw role definitions
 * (engineer, gtm, recruiter, cse, pm, researcher) imported from
 * `lib/workers/templates.ts`. Seeding is idempotent — keyed on `type`,
 * so re-running `seedWorkerTemplates` updates rather than duplicates.
 *
 * The heavy `WORKER_TEMPLATES` array (~25KB of system prompts + tool
 * schemas) is dynamically imported only inside the seed mutation so the
 * read-path query bundles stay small.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const WORKER_TYPE = v.union(
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
    // Stable ordering so the UI doesn't reshuffle on each render.
    return await ctx.db.query("worker_templates").withIndex("by_type").collect();
  },
});

export const getByType = query({
  args: { type: WORKER_TYPE },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("worker_templates")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .first();
  },
});

/**
 * Idempotent seed. Re-running yields exactly 6 rows — existing rows
 * are patched in place rather than duplicated. Stamps created_at on
 * first insert and updated_at on every write.
 */
export const seedWorkerTemplates = mutation({
  args: {},
  handler: async (ctx) => {
    // Lazy-load the heavy template module so list/getByType bundles
    // don't ship the full prompt text.
    const { WORKER_TEMPLATES } = await import("../lib/workers/templates");

    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const t of WORKER_TEMPLATES) {
      const existing = await ctx.db
        .query("worker_templates")
        .withIndex("by_type", (q) => q.eq("type", t.type))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          display_name: t.display_name,
          description: t.description,
          default_corpora: t.default_corpora,
          system_prompt: t.system_prompt,
          tools: t.tools,
          updated_at: now,
        });
        updated++;
      } else {
        await ctx.db.insert("worker_templates", {
          ...t,
          created_at: now,
          updated_at: now,
        });
        inserted++;
      }
    }

    return { inserted, updated, total: WORKER_TEMPLATES.length };
  },
});

export const remove = mutation({
  args: { id: v.id("worker_templates") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
