/**
 * GET /api/agents/directory
 * Lists all active digital employees as A2A agent cards. Mirrors the
 * Nia "agent directory" entity used for capability search.
 */
import { NextResponse } from "next/server";
import { getConvex } from "@/lib/convex-server";
import { api } from "@/convex/_generated/api";

export const runtime = "nodejs";

export async function GET() {
  const convex = getConvex();
  const agents = await convex.query(api.digitalEmployees.listActive, {});
  return NextResponse.json({
    agents: agents.map(
      (a: {
        _id: string;
        name: string;
        role: string;
        agentmail_address: string;
        a2a_endpoint_url: string;
        skills: string[];
        a2a_card: unknown;
        knowledge_stats: { sources_indexed: number; last_indexed_at: number };
      }) => ({
        id: a._id,
        name: a.name,
        role: a.role,
        inbox: a.agentmail_address,
        a2a_url: a.a2a_endpoint_url,
        skills: a.skills,
        knowledge: a.knowledge_stats,
        card: a.a2a_card,
      })
    ),
  });
}
