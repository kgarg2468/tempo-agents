"use node";

/**
 * Iron Claw worker runner.
 *
 * `dispatchTask` is the single entry point for kicking a worker off on a
 * brief. It loads the worker instance, resolves its template, merges
 * CORE_TOOLS into the template's tool catalog, and drives an Anthropic
 * tool-use loop. Every reasoning step, tool call, tool result, and final
 * report is persisted as a `worker_task_steps` row in order so the UI
 * can replay the deliberation in real time.
 *
 * Hard caps:
 *   - Turns: pulled from per-role MAX_TURNS_BY_ROLE (matches the prompt
 *     contract baked into each template).
 *   - Tool dispatch: every call goes through lib/workerTools.executeTool.
 *     CORE tools have real implementations; role-specific tools return
 *     deterministic stubs so the loop can complete end-to-end before
 *     real integrations land.
 *
 * Demo fallback:
 *   When ANTHROPIC_API_KEY is unset, the loop runs a canned sequence
 *   (log_reasoning_step + mark_task_done) so the orchestration is
 *   exercised even without a key.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6-20250929";

const MAX_TURNS_BY_ROLE: Record<string, number> = {
  engineer: 12,
  gtm: 10,
  recruiter: 12,
  cse: 10,
  pm: 12,
  researcher: 15,
};

export const dispatchTask = action({
  args: {
    worker_id: v.id("worker_instances"),
    brief: v.string(),
    agentmail_thread_id: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    task_id: Id<"worker_tasks">;
    status: string;
    turns: number;
    summary?: string;
  }> => {
    // ---- Resolve worker + template ------------------------------------
    const worker = await ctx.runQuery(api.workers.get, { id: args.worker_id });
    if (!worker) throw new Error("worker not found");
    if (worker.status !== "active") throw new Error("worker is not active");

    const template = await ctx.runQuery(api.workerTemplates.getByType, {
      type: worker.template_type,
    });
    if (!template) throw new Error(`template "${worker.template_type}" not seeded`);

    // ---- Create task row ----------------------------------------------
    const taskId: Id<"worker_tasks"> = await ctx.runMutation(api.workerTasks.create, {
      worker_id: args.worker_id,
      brief: args.brief,
      agentmail_thread_id: args.agentmail_thread_id,
    });
    await ctx.runMutation(api.workerTasks.setStatus, {
      id: taskId,
      status: "in_progress",
    });

    // ---- Build tool catalog (CORE merged in, CORE wins on name conflict)
    const { CORE_TOOLS } = await import("../lib/workers/templates");
    const seen = new Set<string>();
    const mergedTools: Array<{
      name: string;
      description: string;
      input_schema: unknown;
    }> = [];
    for (const t of CORE_TOOLS) {
      mergedTools.push(t);
      seen.add(t.name);
    }
    for (const t of template.tools) {
      if (!seen.has(t.name)) mergedTools.push(t);
    }

    // ---- Tool dispatch helpers (closure over ctx + taskId) -------------
    const { executeTool } = await import("../lib/workerTools");
    let turn = 0;

    const dispatchCtx = {
      taskId: String(taskId),
      workerName: worker.name,
      workerType: worker.template_type,
      appendStep: async (
        kind: "reasoning" | "tool_call" | "tool_result" | "final",
        content: string,
        toolName?: string
      ) => {
        await ctx.runMutation(api.workerTasks.addStep, {
          task_id: taskId,
          turn,
          kind,
          content,
          tool_name: toolName,
        });
      },
      setStatus: async (
        status: "in_progress" | "waiting_input" | "done" | "failed" | "refused",
        extras?: { result_summary?: string; deliverable_url?: string; error?: string; finished?: boolean }
      ) => {
        await ctx.runMutation(api.workerTasks.setStatus, {
          id: taskId,
          status,
          ...extras,
        });
      },
    };

    const maxTurns = MAX_TURNS_BY_ROLE[worker.template_type] ?? 10;

    // ---- Demo fallback when no API key --------------------------------
    if (!process.env.ANTHROPIC_API_KEY) {
      await dispatchCtx.appendStep(
        "reasoning",
        "DEMO MODE: ANTHROPIC_API_KEY unset; emitting canned completion"
      );
      const summary = `Demo run for ${worker.name} (${worker.template_type}). Brief: ${args.brief}`;
      await dispatchCtx.setStatus("done", {
        result_summary: summary,
        finished: true,
      });
      await dispatchCtx.appendStep("final", summary);
      return { task_id: taskId, status: "done", turns: 0, summary };
    }

    // ---- Real Anthropic tool-use loop ---------------------------------
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    type AnyMessage = {
      role: "user" | "assistant";
      content: unknown;
    };
    const messages: AnyMessage[] = [
      { role: "user", content: args.brief },
    ];

    let lastSummary: string | undefined;
    let finalStatus: "done" | "failed" | "refused" | "waiting_input" | "in_progress" = "in_progress";

    try {
      for (turn = 1; turn <= maxTurns; turn++) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system: [
            {
              type: "text",
              text: template.system_prompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: mergedTools as unknown as Anthropic.Tool[],
          messages: messages as unknown as Anthropic.MessageParam[],
        });

        // Append the assistant turn so subsequent tool_results can ref it.
        messages.push({ role: "assistant", content: response.content });

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        // No tool_use this turn → record any text and exit.
        if (toolUses.length === 0) {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) {
            await dispatchCtx.appendStep("final", text);
            lastSummary = text;
          }
          finalStatus = "done";
          await dispatchCtx.setStatus("done", {
            result_summary: lastSummary ?? "(no text response)",
            finished: true,
          });
          break;
        }

        // Dispatch every tool_use in this turn and feed results back.
        const toolResultBlocks: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];
        let endsLoop = false;
        let endsLoopStatus: "done" | "failed" | "refused" | "waiting_input" | undefined;

        for (const tu of toolUses) {
          await dispatchCtx.appendStep(
            "tool_call",
            JSON.stringify(tu.input).slice(0, 4000),
            tu.name
          );

          const result = await executeTool(
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>,
            dispatchCtx
          );

          const serialized = JSON.stringify(result.output).slice(0, 8000);
          await dispatchCtx.appendStep(
            "tool_result",
            serialized,
            tu.name
          );

          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: serialized,
            is_error: !result.ok,
          });

          if (result.endsLoop) {
            endsLoop = true;
            // Last endsLoop tool wins if multiple in same turn.
            if (result.endsLoopStatus) endsLoopStatus = result.endsLoopStatus;
          }
        }

        messages.push({ role: "user", content: toolResultBlocks });

        if (endsLoop) {
          finalStatus = endsLoopStatus ?? "done";
          break;
        }

        if (response.stop_reason === "end_turn") {
          finalStatus = "done";
          await dispatchCtx.setStatus("done", { finished: true });
          break;
        }
      }

      if (finalStatus === "in_progress") {
        // Hit turn cap without resolving.
        finalStatus = "failed";
        const msg = `turn cap (${maxTurns}) exceeded without mark_task_done`;
        await dispatchCtx.setStatus("failed", {
          error: msg,
          finished: true,
        });
        await dispatchCtx.appendStep("final", msg);
        lastSummary = msg;
      }
    } catch (err) {
      finalStatus = "failed";
      const msg = err instanceof Error ? err.message : String(err);
      await dispatchCtx.setStatus("failed", { error: msg, finished: true });
      await dispatchCtx.appendStep("final", `ERROR: ${msg}`);
      lastSummary = msg;
    }

    return {
      task_id: taskId,
      status: finalStatus,
      turns: turn,
      summary: lastSummary,
    };
  },
});
