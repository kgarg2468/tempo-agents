/**
 * POST /api/email/webhook
 *
 * AgentMail inbound webhook. Verifies the HMAC signature, parses the
 * event, and forwards to the Convex `handleInbound` action which owns
 * dedup-by-message_id, Claude reply drafting, and AgentMail send-back.
 *
 * Status code policy:
 *   400 — malformed body (won't change on retry)
 *   401 — bad signature (won't change on retry)
 *   500 — handler threw (will change on retry, AgentMail should retry)
 *   200 — handled or known-permanent ignore (parse-failure, unknown thread)
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";
import { parseInboundEvent, verifyWebhookSignature } from "@/lib/agentmail";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const raw = await req.text();
  const sig =
    req.headers.get("x-agentmail-signature") ??
    req.headers.get("x-signature") ??
    req.headers.get("x-webhook-signature");

  if (!verifyWebhookSignature(raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const event = parseInboundEvent(payload);
  if (!event) {
    console.warn("[email/webhook] could not parse inbound event");
    return NextResponse.json(
      { ok: true, ignored: "could not parse event" },
      { status: 200 }
    );
  }

  const convex = getConvex();
  try {
    const result = await convex.action(api.emailHandler.handleInbound, {
      thread_id: event.thread_id,
      message_id: event.message_id,
      from: event.from,
      to: event.to,
      subject: event.subject,
      body: event.body,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[email/webhook] handler failed", {
      message_id: event.message_id,
      thread_id: event.thread_id,
      from: event.from,
      error: message,
      stack,
    });
    // Return 5xx so AgentMail retries on transient failures (Convex
    // outage, Anthropic timeout, AgentMail send error). Permanent
    // failures should be caught and turned into 200 inside `handleInbound`.
    return NextResponse.json(
      { ok: false, error: "handler failed", details: message },
      { status: 500 },
    );
  }
}
