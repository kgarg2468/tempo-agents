"use node";

/**
 * A2A inbound handler. Called from the JSON-RPC route once a peer agent
 * (or the orchestrator) sends a `message/send` to one of our digital
 * employees. Mirrors emailHandler.ts: Nia search → Claude → reply via
 * A2A; shadow-CCs the manager via AgentMail so the audit trail is one
 * inbox, not two transports.
 */

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { A2ATask, A2AMessagePart } from "../lib/a2a";

const MANAGER_DEFAULT = () =>
  process.env.OPENFIRE_MANAGER_EMAIL ??
  process.env.AGENTMAIL_INBOX_ADDRESS ??
  "manager@openfire.local";

export const handleInbound = action({
  args: {
    agent_entity_id: v.string(), // path param from /api/a2a/[agent_id]
    sender_address: v.string(),
    text: v.string(),
    context_id: v.string(),
    message_id: v.string(),
    // WorkerTaskBundle fields — when present, narrow the Nia search to
    // avoid redundant round-trips for sources the task doesn't need.
    source_types: v.optional(v.array(v.string())),
    namespaces: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { agent_entity_id, sender_address, text, context_id, message_id, source_types, namespaces }
  ): Promise<A2ATask> => {
    const agents = await ctx.runQuery(api.digitalEmployees.list, {});
    const agent = agents.find(
      (a: { nozomio_entity_id: string }) =>
        a.nozomio_entity_id === agent_entity_id
    );
    if (!agent) {
      return failedTask(
        message_id,
        context_id,
        `unknown agent ${agent_entity_id}`
      );
    }

    // Idempotency
    const dup = await ctx.runQuery(api.threads.messageByExternalId, {
      external_id: message_id,
    });
    if (dup) {
      return completedTask(
        message_id,
        context_id,
        "Already processed.",
        agent.name
      );
    }

    // Ensure thread exists
    const managerAddress = MANAGER_DEFAULT();
    await ctx.runMutation(api.threads.ensureThread, {
      thread_id: context_id,
      title: `A2A — ${agent.name}`,
      participants: [agent.agentmail_address, sender_address, managerAddress],
    });

    // Persist inbound A2A message + index into Nia.
    await ctx.runAction(api.threads.appendAndIndex, {
      thread_id: context_id,
      transport: "a2a",
      direction: "inbound",
      sender: sender_address,
      recipients: [agent.agentmail_address],
      body: text,
      citations: [],
      external_id: message_id,
    });

    // Nia retrieval. When the orchestrator provided explicit namespaces or
    // source_types via WorkerTaskBundle, use them to skip irrelevant sources
    // and avoid redundant round-trips (RUBICON/AQL data-query pattern).
    const { unifiedSearch } = await import("../lib/nozomio");
    const searchNamespaces =
      namespaces && namespaces.length > 0
        ? namespaces
        : [context_id, agent.nozomio_entity_id];
    const search = await unifiedSearch(searchNamespaces, text, source_types);

    // Compose reply via Claude.
    const { generateAgentReply } = await import("../lib/claude");
    const threadMsgs = await ctx.runQuery(api.threads.messagesForThread, {
      thread_id: context_id,
    });
    const reply = await generateAgentReply({
      agent: {
        name: agent.name,
        role: agent.role,
        agentmail_address: agent.agentmail_address,
      },
      thread: threadMsgs.map(
        (m: {
          direction: "inbound" | "outbound";
          sender: string;
          subject?: string;
          body: string;
        }) => ({
          direction: m.direction,
          from: m.sender,
          subject: m.subject ?? "",
          body: m.body,
        })
      ),
      niaCitations: search.citations,
    });

    // Send reply via A2A back to caller (best-effort; if no endpoint URL,
    // we still record + email-CC manager). For the demo, the orchestrator
    // is the typical caller and reads the response synchronously from the
    // returned A2ATask, so we don't need a separate outbound A2A call.
    const replyMessageId = `a2a_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    await ctx.runAction(api.threads.appendAndIndex, {
      thread_id: context_id,
      transport: "a2a",
      direction: "outbound",
      sender: agent.agentmail_address,
      recipients: [sender_address],
      subject: reply.subject,
      body: reply.reply,
      citations: search.citations.map((c) => ({
        source_id: c.source_id,
        label: c.label,
        freshness: c.freshness,
      })),
      external_id: replyMessageId,
    });

    // Shadow CC manager via AgentMail (single audit trail). Scheduled
    // rather than awaited so the A2ATask returns immediately, but Convex
    // owns the lifetime — unawaited promises in actions get killed when
    // the lambda returns, so fire-and-forget would silently lose emails.
    await ctx.scheduler.runAfter(0, internal.a2aHandler.sendManagerCc, {
      to: managerAddress,
      from: agent.agentmail_address,
      subject: `[A2A audit] ${reply.subject}`,
      body:
        `(A2A audit copy — agent ${agent.name} replied to ${sender_address})\n\n` +
        reply.reply,
      thread_id: context_id,
    });

    return completedTask(message_id, context_id, reply.reply, agent.name);
  },
});

export const sendManagerCc = internalAction({
  args: {
    to: v.string(),
    from: v.string(),
    subject: v.string(),
    body: v.string(),
    thread_id: v.string(),
  },
  handler: async (_ctx, args) => {
    try {
      const { sendEmail } = await import("../lib/agentmail");
      await sendEmail({
        to: args.to,
        from: args.from,
        subject: args.subject,
        body: args.body,
        thread_id: args.thread_id,
      });
    } catch (err) {
      console.warn("[a2aHandler.sendManagerCc] failed:", err);
    }
  },
});

function completedTask(
  taskId: string,
  contextId: string,
  text: string,
  agentName: string
): A2ATask {
  const parts: A2AMessagePart[] = [{ kind: "text", text }];
  return {
    id: `task_${taskId}`,
    contextId,
    status: {
      state: "completed",
      message: {
        role: "agent",
        parts,
        messageId: `msg_${Date.now()}`,
        contextId,
        taskId: `task_${taskId}`,
      },
    },
    artifacts: [
      {
        artifactId: `art_${taskId}`,
        name: `${agentName}-reply`,
        parts,
      },
    ],
    kind: "task",
  };
}

function failedTask(
  taskId: string,
  contextId: string,
  reason: string
): A2ATask {
  return {
    id: `task_${taskId}`,
    contextId,
    status: {
      state: "failed",
      message: {
        role: "agent",
        parts: [{ kind: "text", text: reason }],
        messageId: `msg_${Date.now()}`,
        contextId,
      },
    },
    kind: "task",
  };
}
