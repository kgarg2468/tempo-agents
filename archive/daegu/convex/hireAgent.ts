"use node";

/**
 * Hire orchestrator. Provisions a new digital employee:
 *  1. Pull predecessor's Nia evidence (or net-new role placeholder).
 *  2. Provision an AgentMail inbox via lib/agentmail#createInbox.
 *  3. Knowledge-transfer the predecessor's source bundle into a fresh
 *     Nia entity namespace via lib/nozomio#ingestSourcesForEntity.
 *  4. Build the A2A agent card.
 *  5. Persist the digital_employees row.
 *  6. Generate the onboarding email via Claude.
 *  7. Send the onboarding email FROM the new inbox to the manager.
 *
 * Idempotent on (replaces_employee_id, name) by virtue of the
 * by_inbox uniqueness check inside digitalEmployees.create.
 */

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const NAME_POOL = [
  "Ada",
  "Ben",
  "Cleo",
  "Doro",
  "Echo",
  "Faye",
  "Gus",
  "Hana",
  "Ivo",
  "Juno",
];

function pickName(seed: number): string {
  return NAME_POOL[seed % NAME_POOL.length];
}

function publicHostFromEnv(): string {
  return (
    process.env.OPENFIRE_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    "http://localhost:3000"
  );
}

export const hireReplacement = action({
  args: {
    employee_id: v.id("employees"),
    role_override: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { employee_id, role_override }
  ): Promise<{
    digital_employee_id: Id<"digital_employees">;
    agentmail_address: string;
    a2a_endpoint_url: string;
    onboarding_thread_id: string;
    sources_indexed: number;
    alreadyExisted: boolean;
  }> => {
    const employee = await ctx.runQuery(api.employees.get, {
      id: employee_id,
    });
    if (!employee) throw new Error("employee not found");

    const seed = (employee.name as string)
      .split("")
      .reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
    const baseName = pickName(seed);
    const shortId = Math.random().toString(36).slice(2, 6);
    const newAgentName = `${baseName}`;
    const role = role_override ?? employee.role;
    const localPart = `${baseName.toLowerCase()}-${shortId}`;

    const { getEntityContext, ingestSourcesForEntity } = await import(
      "../lib/nozomio"
    );
    const { createInbox, sendEmail } = await import("../lib/agentmail");
    const { buildAgentCard } = await import("../lib/a2a");
    const { generateOnboardingEmail } = await import("../lib/claude");

    // 1. Predecessor evidence
    const predecessorContext = employee.nozomio_entity_id
      ? await getEntityContext(employee.nozomio_entity_id)
      : { entity_id: "", summary: "(no predecessor evidence)", sources: [] };

    // 2. Provision inbox
    const inbox = await createInbox(localPart);

    // 3. Knowledge transfer into new Nia entity namespace
    const newEntityId = `de_${baseName.toLowerCase()}_${shortId}`;
    const ingest = await ingestSourcesForEntity(
      newEntityId,
      predecessorContext.sources.map((s) => ({
        type: s.type,
        name: s.name,
        body: s.summary,
        metadata: { signals: s.signals },
      }))
    );

    // 4. Agent card
    const a2a_endpoint_url = `${publicHostFromEnv()}/api/a2a/${newEntityId}`;
    const card = buildAgentCard({
      name: `${newAgentName} (replaces ${employee.name})`,
      description: `Digital employee for ${role}. Knowledge ingested from ${employee.name}.`,
      url: a2a_endpoint_url,
    });

    // 5. Persist
    const digital_employee_id = await ctx.runMutation(
      api.digitalEmployees.create,
      {
        name: newAgentName,
        role,
        replaces_employee_id: employee_id,
        nozomio_entity_id: newEntityId,
        agentmail_inbox_id: inbox.inbox_id,
        agentmail_address: inbox.address,
        a2a_endpoint_url,
        a2a_card: card,
        skills: ["answer", "handoff"],
        is_orchestrator: false,
        sources_indexed: ingest.sources_indexed,
      }
    );

    const existing = await ctx.runQuery(api.digitalEmployees.getByInbox, {
      agentmail_address: inbox.address,
    });
    const alreadyExisted = Boolean(
      existing && existing._id !== digital_employee_id
    );

    // 6. Onboarding email content
    const onboarding = await generateOnboardingEmail(
      {
        name: newAgentName,
        role,
        agentmail_address: inbox.address,
        knowledge_stats: { sources_indexed: ingest.sources_indexed },
        replaces_name: employee.name,
      },
      predecessorContext
    );

    // 7. Send onboarding email FROM the new inbox TO the manager.
    const managerAddress =
      process.env.OPENFIRE_MANAGER_EMAIL ??
      process.env.AGENTMAIL_INBOX_ADDRESS ??
      "manager@openfire.local";

    const sent = await sendEmail({
      to: managerAddress,
      from: inbox.address,
      subject: onboarding.subject,
      body: onboarding.email,
    });

    // Persist the hire decision row.
    const hireDecisionId = await ctx.runMutation(
      api.hireDecisions.create,
      {
        digital_employee_id,
        reasoning: onboarding.evidence_summary,
        onboarding_email: onboarding.email,
        evidence_summary: onboarding.evidence_summary,
        agentmail_thread_id: sent.thread_id,
      }
    );
    await ctx.runMutation(api.hireDecisions.markSent, {
      id: hireDecisionId,
    });

    // Mirror into the multi-agent thread store + Nia thread namespace.
    await ctx.runMutation(api.threads.ensureThread, {
      thread_id: sent.thread_id,
      title: `Onboarding: ${newAgentName}`,
      participants: [inbox.address, managerAddress],
    });
    await ctx.runAction(api.threads.appendAndIndex, {
      thread_id: sent.thread_id,
      transport: "email",
      direction: "outbound",
      sender: inbox.address,
      recipients: [managerAddress],
      subject: onboarding.subject,
      body: onboarding.email,
      citations: [],
      external_id: sent.message_id,
    });

    return {
      digital_employee_id,
      agentmail_address: inbox.address,
      a2a_endpoint_url,
      onboarding_thread_id: sent.thread_id,
      sources_indexed: ingest.sources_indexed,
      alreadyExisted,
    };
  },
});
