/**
 * POST /api/decisions/[id]/approve   -> approves + sends termination email
 * POST /api/decisions/[id]/reject    -> spares the employee
 *
 * Both are idempotent:
 *  - Approving an already-sent decision returns the existing thread id
 *    without re-sending.
 *  - Rejecting an already-rejected decision is a no-op.
 *
 * The actual side effects (AgentMail send, status transitions) live in
 * `convex/agent.ts:approveDecision` and `convex/decisions.ts:reject`.
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; action: string }> }
) {
  const { id, action } = await ctx.params;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  const convex = getConvex();

  if (action === "reject") {
    try {
      await convex.mutation(api.decisions.reject, { id: id as never });
      return NextResponse.json({ ok: true, action: "rejected" });
    } catch (e: unknown) {
      return NextResponse.json(
        {
          error: "reject failed",
          details: e instanceof Error ? e.message : String(e),
        },
        { status: 500 }
      );
    }
  }

  // approve -> delegate to the action so AgentMail send + idempotency
  // logic stays in one place.
  try {
    const result = await convex.action(api.agent.approveDecision, {
      decision_id: id as never,
    });
    return NextResponse.json({
      ok: true,
      action: result.alreadySent ? "already-sent" : "sent",
      thread_id: result.threadId,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: "approve failed",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
