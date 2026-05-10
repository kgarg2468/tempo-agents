/**
 * POST /api/agent/run
 *
 * Triggers the OpenFire agent. With no body, runs the full loop across
 * every active employee. With `{employee_id}`, evaluates a single
 * employee. The heavy lifting lives in `convex/agent.ts:runFireAgent` so
 * that idempotency, Nozomio access, and Claude calls all happen on the
 * Convex side.
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";

interface RunBody {
  employee_id?: string;
}

export async function POST(req: Request) {
  let body: RunBody = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as RunBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const convex = getConvex();

  try {
    const result = await convex.action(api.agent.runFireAgent, {
      employee_id: body.employee_id as never,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: "agent run failed",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
