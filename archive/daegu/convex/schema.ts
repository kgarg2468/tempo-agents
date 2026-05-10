import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  employees: defineTable({
    name: v.string(),
    email: v.string(),
    role: v.string(),
    nozomio_entity_id: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("pending"),
      v.literal("fired"),
      v.literal("spared")
    ),
    created_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_email", ["email"]),

  decisions: defineTable({
    employee_id: v.id("employees"),
    reasoning: v.string(),
    decision: v.union(v.literal("fire"), v.literal("spare")),
    email_draft: v.string(),
    agentmail_thread_id: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("sent"),
      v.literal("escalated")
    ),
    created_at: v.number(),
    // Set when handleReply or evaluateEmployee bails out and asks a human
    // to take over (e.g. evidence is too thin to act on).
    escalated_reason: v.optional(v.string()),
    // Filled in by book_exit_interview tool — replaces the regex check in
    // emailHandler.ts so the reply loop knows the slot is booked.
    exit_interview_event_id: v.optional(v.string()),
    // How many tool-use iterations the agent ran to reach this decision.
    // Useful for cost / quality regression tracking.
    iterations: v.optional(v.number()),
  })
    .index("by_employee", ["employee_id"])
    .index("by_status", ["status"])
    .index("by_thread", ["agentmail_thread_id"]),

  tool_calls: defineTable({
    decision_id: v.id("decisions"),
    iteration: v.number(),
    tool_name: v.string(),
    // Stored as JSON strings so the schema doesn't have to enumerate every
    // tool's input/output shape. The dispatcher owns serialization.
    input_json: v.string(),
    output_json: v.string(),
    is_error: v.boolean(),
    duration_ms: v.number(),
    created_at: v.number(),
  })
    .index("by_decision", ["decision_id"])
    .index("by_decision_and_iteration", ["decision_id", "iteration"]),

  criteria: defineTable({
    name: v.string(),
    description: v.string(),
    weight: v.number(),
    active: v.boolean(),
  }).index("by_active", ["active"]),

  messages: defineTable({
    decision_id: v.id("decisions"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    subject: v.string(),
    body: v.string(),
    from: v.string(),
    created_at: v.number(),
    agentmail_message_id: v.optional(v.string()),
  })
    .index("by_decision", ["decision_id"])
    .index("by_message_id", ["agentmail_message_id"]),

  worker_templates: defineTable({
    type: v.union(
      v.literal("engineer"),
      v.literal("gtm"),
      v.literal("recruiter"),
      v.literal("cse"),
      v.literal("pm"),
      v.literal("researcher")
    ),
    display_name: v.string(),
    description: v.string(),
    default_corpora: v.array(v.string()),
    system_prompt: v.string(),
    // Tighter than v.any(): require at minimum the Anthropic tool-use top-level
    // shape. input_schema stays free-form because it varies wildly per tool.
    tools: v.array(
      v.object({
        name: v.string(),
        description: v.string(),
        input_schema: v.any(),
      })
    ),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  }).index("by_type", ["type"]),

  worker_instances: defineTable({
    template_type: v.union(
      v.literal("engineer"),
      v.literal("gtm"),
      v.literal("recruiter"),
      v.literal("cse"),
      v.literal("pm"),
      v.literal("researcher")
    ),
    name: v.string(),
    agentmail_inbox_id: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("fired")),
    hired_at: v.number(),
    fired_at: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_template_type", ["template_type"]),

  worker_tasks: defineTable({
    worker_id: v.id("worker_instances"),
    brief: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("waiting_input"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("refused")
    ),
    result_summary: v.optional(v.string()),
    deliverable_url: v.optional(v.string()),
    agentmail_thread_id: v.optional(v.string()),
    error: v.optional(v.string()),
    created_at: v.number(),
    finished_at: v.optional(v.number()),
  })
    .index("by_worker", ["worker_id"])
    .index("by_status", ["status"]),

  worker_task_steps: defineTable({
    task_id: v.id("worker_tasks"),
    turn: v.number(),
    kind: v.union(
      v.literal("reasoning"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("final")
    ),
    content: v.string(),
    tool_name: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_task", ["task_id"]),

  digital_employees: defineTable({
    name: v.string(),
    role: v.string(),
    replaces_employee_id: v.optional(v.id("employees")),
    nozomio_entity_id: v.string(),
    agentmail_inbox_id: v.string(),
    agentmail_address: v.string(),
    a2a_endpoint_url: v.string(),
    a2a_card: v.any(),
    skills: v.array(v.string()),
    is_orchestrator: v.boolean(),
    status: v.union(
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("retired")
    ),
    knowledge_stats: v.object({
      sources_indexed: v.number(),
      last_indexed_at: v.number(),
    }),
    created_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_inbox", ["agentmail_address"])
    .index("by_replaces", ["replaces_employee_id"])
    .index("by_orchestrator", ["is_orchestrator"]),

  hire_decisions: defineTable({
    digital_employee_id: v.id("digital_employees"),
    reasoning: v.string(),
    onboarding_email: v.string(),
    evidence_summary: v.string(),
    agentmail_thread_id: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("sent")
    ),
    created_at: v.number(),
  }).index("by_digital_employee", ["digital_employee_id"]),

  threads: defineTable({
    thread_id: v.string(),
    title: v.string(),
    participants: v.array(v.string()),
    nia_namespace: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("paused"),
      v.literal("closed")
    ),
    created_at: v.number(),
  })
    .index("by_thread_id", ["thread_id"])
    .index("by_status", ["status"]),

  thread_messages: defineTable({
    thread_id: v.string(),
    transport: v.union(v.literal("email"), v.literal("a2a")),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    sender: v.string(),
    recipients: v.array(v.string()),
    subject: v.optional(v.string()),
    body: v.string(),
    citations: v.array(
      v.object({
        source_id: v.string(),
        label: v.string(),
        freshness: v.optional(v.number()),
      })
    ),
    external_id: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_thread", ["thread_id"])
    .index("by_external_id", ["external_id"]),
});
