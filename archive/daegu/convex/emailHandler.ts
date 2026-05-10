"use node";

/**
 * Inbound email handler. Called from the AgentMail webhook route after
 * HMAC verification succeeds. Idempotent: if we have already seen the
 * given `agentmail_message_id`, the action returns early without calling
 * Claude or sending another reply. This matters because AgentMail may
 * retry webhook deliveries on transient errors.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export const handleInbound = action({
  args: {
    thread_id: v.string(),
    message_id: v.string(),
    from: v.string(),
    to: v.optional(v.string()),
    subject: v.string(),
    body: v.string(),
  },
  handler: async (
    ctx,
    { thread_id, message_id, from, to, subject, body }
  ): Promise<{
    deduped?: boolean;
    unknownThread?: boolean;
    replied?: boolean;
    routedToDigitalEmployee?: boolean;
    scheduledExitInterview?: boolean;
  }> => {
    // 1) Have we processed this exact AgentMail message before?
    const existing = await ctx.runQuery(api.messages.byMessageId, {
      agentmail_message_id: message_id,
    });
    if (existing) return { deduped: true };

    // 1b) Is this email addressed to a provisioned digital employee?
    //     Route to that agent's reply path instead of the termination
    //     thread handler. Multiple addresses in `to` are split on comma.
    if (to) {
      const recipients = to
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      for (const addr of recipients) {
        const matched = await ctx.runQuery(api.digitalEmployees.getByInbox, {
          agentmail_address: addr,
        });
        if (matched) {
          await ctx.runAction(api.a2aHandler.handleInbound, {
            agent_entity_id: matched.nozomio_entity_id,
            sender_address: from,
            text: body,
            context_id: thread_id,
            message_id,
          });
          return { replied: true, routedToDigitalEmployee: true };
        }
      }
    }

    // 2) Find the matching termination thread.
    const decision = await ctx.runQuery(api.decisions.getByThreadId, {
      thread_id,
    });
    if (!decision) return { unknownThread: true };

    const employee = await ctx.runQuery(api.employees.get, {
      id: decision.employee_id,
    });
    if (!employee) return { unknownThread: true };

    // 3) Persist the inbound message.
    await ctx.runMutation(api.messages.create, {
      decision_id: decision._id as Id<"decisions">,
      direction: "inbound",
      subject,
      body,
      from,
      agentmail_message_id: message_id,
    });

    // 4) Pull the running thread, ask Claude for a reply.
    const thread = await ctx.runQuery(api.messages.listForDecision, {
      decision_id: decision._id as Id<"decisions">,
    });

    const { handleReply } = await import("../lib/claude");
    const turns = thread.map(
      (m: {
        direction: "inbound" | "outbound";
        from: string;
        subject: string;
        body: string;
      }) => ({
        direction: m.direction,
        from: m.from,
        subject: m.subject,
        body: m.body,
      })
    );
    const replyResult = await handleReply(turns, decision.reasoning);

    // 5) Send the reply via AgentMail (within the same thread).
    const { sendEmail } = await import("../lib/agentmail");
    const sent = await sendEmail({
      to: from,
      subject: replyResult.subject,
      body: replyResult.reply,
      thread_id,
      reply_to_message_id: message_id,
    });

    await ctx.runMutation(api.messages.create, {
      decision_id: decision._id as Id<"decisions">,
      direction: "outbound",
      subject: replyResult.subject,
      body: replyResult.reply,
      from: process.env.AGENTMAIL_INBOX_ADDRESS ?? "claw@openfire.local",
      agentmail_message_id: sent.message_id,
    });

    // 6) If Claude offered an exit interview, schedule one — but only
    //    once per decision. The optional `exit_interview_event_id` field
    //    on `decisions` would be the cleaner home; for now the presence
    //    of an interview-scheduling reply line is the trigger and we
    //    debounce by checking whether *any* existing outbound message
    //    in the thread already references "Exit Interview".
    let scheduledExitInterview = false;
    const wantsInterview = /exit interview|exit-interview/i.test(
      replyResult.reply
    );
    if (wantsInterview) {
      const alreadyScheduled = thread.some((m: { body: string }) =>
        /exit interview scheduled/i.test(m.body)
      );
      if (!alreadyScheduled) {
        try {
          const { scheduleExitInterview } = await import("../lib/calendar");
          const ev = await scheduleExitInterview(employee.email, employee.name);
          await ctx.runMutation(api.messages.create, {
            decision_id: decision._id as Id<"decisions">,
            direction: "outbound",
            subject: `Exit Interview Scheduled — ${employee.name}`,
            body: `Exit interview scheduled for ${ev.start}. Calendar event id: ${ev.event_id}.`,
            from: process.env.AGENTMAIL_INBOX_ADDRESS ?? "claw@openfire.local",
          });
          scheduledExitInterview = true;
        } catch (e) {
          console.warn("[emailHandler] calendar schedule failed:", e);
        }
      }
    }

    return { replied: true, scheduledExitInterview };
  },
});
