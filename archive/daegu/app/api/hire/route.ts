/**
 * POST /api/hire
 * Body: { employee_id: string, role_override?: string }
 * Spawns a digital employee replacing the given (typically fired) employee.
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let payload: { employee_id?: string; role_override?: string };
  try {
    payload = (await req.json()) as {
      employee_id?: string;
      role_override?: string;
    };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!payload.employee_id) {
    return NextResponse.json(
      { error: "employee_id required" },
      { status: 400 }
    );
  }

  const convex = getConvex();
  try {
    // Ensure orchestrator exists before adding worker agents.
    await convex.action(api.seed.ensureOrchestrator, {});
    const result = await convex.action(api.hireAgent.hireReplacement, {
      employee_id: payload.employee_id as never,
      role_override: payload.role_override,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: "hire failed",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
