"use node";

/**
 * Boot-time seed for the orchestrator agent (the "admin bot" in the
 * Discord-style topology). Idempotent: re-running returns the existing
 * orchestrator without provisioning a new inbox.
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

function publicHostFromEnv(): string {
  return (
    process.env.OPENFIRE_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    "http://localhost:3000"
  );
}

export const ensureOrchestrator = action({
  args: {},
  handler: async (
    ctx
  ): Promise<{
    digital_employee_id: Id<"digital_employees">;
    agentmail_address: string;
    a2a_endpoint_url: string;
    created: boolean;
  }> => {
    const existing = await ctx.runQuery(
      api.digitalEmployees.getOrchestrator,
      {}
    );
    if (existing) {
      return {
        digital_employee_id: existing._id,
        agentmail_address: existing.agentmail_address,
        a2a_endpoint_url: existing.a2a_endpoint_url,
        created: false,
      };
    }

    const { createInbox } = await import("../lib/agentmail");
    const { buildAgentCard } = await import("../lib/a2a");

    const inbox = await createInbox("orchestrator");
    const newEntityId = `de_orchestrator_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const a2a_endpoint_url = `${publicHostFromEnv()}/api/a2a/${newEntityId}`;
    const card = buildAgentCard({
      name: "Orchestrator",
      description:
        "OpenFire orchestrator. Decomposes manager requests, dispatches scoped tasks to digital employees, aggregates summaries.",
      url: a2a_endpoint_url,
      skills: [
        { id: "decompose", name: "Decompose tasks into scoped subtasks" },
        { id: "dispatch", name: "Dispatch via A2A to worker agents" },
        { id: "aggregate", name: "Aggregate worker summaries into a reply" },
      ],
    });

    const digital_employee_id = await ctx.runMutation(
      api.digitalEmployees.create,
      {
        name: "Orchestrator",
        role: "Multi-agent coordinator",
        nozomio_entity_id: newEntityId,
        agentmail_inbox_id: inbox.inbox_id,
        agentmail_address: inbox.address,
        a2a_endpoint_url,
        a2a_card: card,
        skills: ["decompose", "dispatch", "aggregate"],
        is_orchestrator: true,
        sources_indexed: 0,
      }
    );

    return {
      digital_employee_id,
      agentmail_address: inbox.address,
      a2a_endpoint_url,
      created: true,
    };
  },
});
