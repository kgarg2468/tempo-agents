"use node";

/**
 * The OpenFire agent loop.
 *
 * `runFireAgent` walks every active employee, gathers context from
 * Nozomio, asks Claude for a verdict against the live criteria, and
 * persists pending decisions. The loop is idempotent at every step:
 * employees with an existing pending/approved/sent decision are skipped
 * so re-running the agent never produces duplicate decisions. A failure
 * on one employee no longer aborts the whole batch — each iteration is
 * try/catch'd and the failed count is returned.
 *
 * `approveDecision` flips a pending decision into "sent" by dispatching
 * the email through AgentMail. It guards on current status so a panicked
 * manager rage-clicking "Approve" only triggers one email, and refuses
 * to send empty drafts (escalated decisions).
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export const runFireAgent = action({
  args: { employee_id: v.optional(v.id("employees")) },
  handler: async (
    ctx,
    { employee_id }
  ): Promise<{
    processed: number;
    flagged: number;
    skipped: number;
    escalated: number;
    failed: number;
  }> => {
    const { getEntityContext } = await import("../lib/nozomio");
    const { evaluateEmployee } = await import("../lib/claude");

    const employees = employee_id
      ? [await ctx.runQuery(api.employees.get, { id: employee_id })].filter(
          (e): e is NonNullable<typeof e> => Boolean(e)
        )
      : await ctx.runQuery(api.employees.listByStatus, { status: "active" });

    const criteria = await ctx.runQuery(api.criteria.listActive, {});

    let processed = 0;
    let flagged = 0;
    let skipped = 0;
    let escalated = 0;
    let failed = 0;

    for (const employee of employees) {
      try {
        // Idempotency guard: don't re-evaluate someone who already has an
        // open (non-rejected) decision.
        const hasOpen = await ctx.runQuery(api.decisions.hasOpenDecision, {
          employee_id: employee._id,
        });
        if (hasOpen) {
          skipped++;
          continue;
        }
        if (!employee.nozomio_entity_id) {
          skipped++;
          continue;
        }

        // Promise-based cache: parallel tool calls share one fetch instead
        // of racing on a null check and triggering duplicate Nozomio requests.
        let contextPromise: Promise<
          Awaited<ReturnType<typeof getEntityContext>>
        > | null = null;
        const getNozomioContext = () =>
          (contextPromise ??= getEntityContext(employee.nozomio_entity_id));

        const searchEmployeeHistory = async (q: string) =>
          await ctx.runQuery(api.agentHistory.searchForEmployee, {
            employee_id: employee._id,
            query: q,
          });

        const loop = await evaluateEmployee(
          {
            name: employee.name,
            email: employee.email,
            role: employee.role,
          },
          criteria.map(
            (c: { name: string; description: string; weight: number }) => ({
              name: c.name,
              description: c.description,
              weight: c.weight,
            })
          ),
          { getNozomioContext, searchEmployeeHistory },
        );

        let decisionId: Id<"decisions"> | null = null;

        if (loop.outcome.kind === "decision") {
          decisionId = await ctx.runMutation(api.decisions.create, {
            employee_id: employee._id,
            reasoning: loop.outcome.result.reasoning,
            decision: loop.outcome.result.decision,
            email_draft: loop.outcome.result.emailDraft,
          });
          if (loop.outcome.result.decision === "fire") flagged++;
          else skipped++;
        } else if (loop.outcome.kind === "escalation") {
          decisionId = await ctx.runMutation(api.decisions.createEscalated, {
            employee_id: employee._id,
            reason: loop.outcome.reason,
          });
          escalated++;
        } else {
          // Loop exhausted without a terminal tool call. Preserve the
          // model's last text so operators can debug why it bailed
          // instead of just seeing a generic message.
          const tail = loop.outcome.lastText.trim().slice(0, 800);
          const reason = tail
            ? `Loop exhausted ${loop.iterations} iterations without verdict. Last model output: ${tail}`
            : `Loop exhausted ${loop.iterations} iterations without verdict and no trailing text.`;
          decisionId = await ctx.runMutation(api.decisions.createEscalated, {
            employee_id: employee._id,
            reason,
          });
          escalated++;
        }

        // Bookkeeping: best-effort. A failure here shouldn't abort the
        // batch — the decision row already exists.
        try {
          if (decisionId && loop.toolCalls.length > 0) {
            await ctx.runMutation(api.toolCalls.recordBatch, {
              decision_id: decisionId,
              calls: loop.toolCalls,
            });
          }
          if (decisionId) {
            await ctx.runMutation(api.decisions.setIterations, {
              id: decisionId,
              iterations: loop.iterations,
            });
          }
        } catch (bookErr) {
          console.warn(
            `[agent] bookkeeping failed for employee ${employee._id}:`,
            bookErr instanceof Error ? bookErr.message : String(bookErr),
          );
        }

        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[agent] employee ${employee._id} failed:`,
          message,
        );
        failed++;
      }
    }

    return { processed, flagged, skipped, escalated, failed };
  },
});

export const approveDecision = action({
  args: { decision_id: v.id("decisions") },
  handler: async (
    ctx,
    { decision_id }
  ): Promise<{
    threadId: string | undefined;
    alreadySent: boolean;
  }> => {
    const decision = await ctx.runQuery(api.decisions.get, { id: decision_id });
    if (!decision) throw new Error("decision not found");

    // Idempotent guard: if it was already sent, return the existing
    // thread id without firing another email.
    if (decision.status === "sent") {
      return {
        threadId: decision.agentmail_thread_id,
        alreadySent: true,
      };
    }
    if (decision.status === "rejected") {
      throw new Error("cannot approve a rejected decision");
    }
    if (decision.status === "escalated") {
      // Escalated decisions have an empty email_draft. Sending an empty
      // termination email would be a customer-harm bug. Force the human
      // to author a fresh decision via a different code path.
      throw new Error(
        "cannot approve an escalated decision — re-run the agent or author a manual decision first",
      );
    }
    if (!decision.email_draft || decision.email_draft.trim().length === 0) {
      throw new Error("cannot approve decision with empty email_draft");
    }

    const employee = await ctx.runQuery(api.employees.get, {
      id: decision.employee_id,
    });
    if (!employee) throw new Error("employee not found");

    const { sendEmail } = await import("../lib/agentmail");
    const subject = `Notice of Termination — ${employee.name}`;
    const result = await sendEmail({
      to: employee.email,
      subject,
      body: decision.email_draft,
    });

    await ctx.runMutation(api.messages.create, {
      decision_id,
      direction: "outbound",
      subject,
      body: decision.email_draft,
      from: process.env.AGENTMAIL_INBOX_ADDRESS ?? "claw@openfire.local",
      agentmail_message_id: result.message_id,
    });

    await ctx.runMutation(api.decisions.markSent, {
      id: decision_id,
      thread_id: result.thread_id,
    });

    return { threadId: result.thread_id, alreadySent: false };
  },
});
