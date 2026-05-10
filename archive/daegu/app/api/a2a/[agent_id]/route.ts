/**
 * POST /api/a2a/[agent_id]
 * JSON-RPC 2.0 endpoint for the A2A protocol. Implements `message/send`
 * and `tasks/get`. Delegates real work to convex/a2aHandler.
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";
import { messageText, type WorkerTaskBundle } from "@/lib/a2a";

export const runtime = "nodejs";

interface RpcReq {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ agent_id: string }> }
) {
  const { agent_id } = await ctx.params;
  let body: RpcReq;
  try {
    body = (await req.json()) as RpcReq;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const id = body.id ?? null;
  const method = body.method ?? "";
  const convex = getConvex();

  if (method === "message/send") {
    const params = (body.params ?? {}) as {
      message?: {
        parts?: Array<{ kind?: string; text?: string; data?: unknown }>;
        messageId?: string;
        contextId?: string;
      };
      sender?: string;
    };
    const message = params.message;
    if (!message) return rpcError(id, -32602, "missing params.message");
    const text = messageText({
      role: "user",
      parts: (message.parts ?? []).map((p) => ({
        kind: p.kind === "text" ? "text" : "data",
        text: p.text,
      })),
      messageId: message.messageId ?? "",
    });
    const context_id =
      message.contextId ??
      `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const message_id =
      message.messageId ??
      `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Extract WorkerTaskBundle from data parts if present.
    const workerTask = (message.parts ?? []).find((p) => p.kind === "data")
      ?.data as WorkerTaskBundle | undefined;

    try {
      const task = await convex.action(api.a2aHandler.handleInbound, {
        agent_entity_id: agent_id,
        sender_address: params.sender ?? "unknown@a2a",
        text,
        context_id,
        message_id,
        ...(workerTask && {
          source_types: workerTask.data_query?.source_types,
          namespaces: workerTask.data_query?.namespaces,
        }),
      });
      return NextResponse.json({ jsonrpc: "2.0", id, result: task });
    } catch (e: unknown) {
      return rpcError(id, -32000, e instanceof Error ? e.message : String(e));
    }
  }

  if (method === "tasks/get") {
    // Tasks are completed synchronously in this implementation, so this
    // is a stub that returns "not found" — clients should rely on the
    // result of message/send instead.
    return rpcError(id, -32001, "tasks/get not retained in this impl");
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string
) {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: 200 }
  );
}
