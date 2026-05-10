/**
 * GET /api/a2a/[agent_id]/agent.json
 * Serves the A2A agent card for a digital employee. The card includes
 * the JSON-RPC endpoint URL and declared skills, per the A2A spec
 * (https://github.com/a2aproject/A2A).
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ agent_id: string }> }
) {
  const { agent_id } = await ctx.params;
  const convex = getConvex();
  const agents = await convex.query(api.digitalEmployees.list, {});
  const agent = agents.find(
    (a: { nozomio_entity_id: string }) => a.nozomio_entity_id === agent_id
  );
  if (!agent) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }
  return NextResponse.json(agent.a2a_card, {
    headers: { "Cache-Control": "public, max-age=30" },
  });
}
