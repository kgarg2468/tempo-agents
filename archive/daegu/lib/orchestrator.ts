/**
 * Orchestrator-worker pattern (Anthropic multi-agent research, 2024;
 * arXiv:2511.03841). The orchestrator decomposes a manager request into
 * scoped subtasks, dispatches each to a worker via A2A with FRESH scoped
 * context (never the raw thread), collects worker summaries, and the
 * caller composes the final reply.
 *
 * Pure-ish: the dispatch function is injected so this file stays testable
 * and free of Convex/network plumbing.
 */

import {
  orchestratorPlan,
  orchestratorAggregate,
  type WorkerTask,
  type OrchestratorTopology,
  type OrchestratorPlan,
} from "./claude";

export type { WorkerTask, OrchestratorPlan } from "./claude";

export interface OrchestratorAgent {
  name: string;
  role: string;
  skills: string[];
  a2a_endpoint_url: string;
  agentmail_address: string;
}

export interface DispatchedResult {
  agent: string;
  output: string;
  structured: Record<string, unknown>;
  cited_source_ids: string[];
  sources: string[];
}

export interface RunOrchestratorParams {
  managerRequest: string;
  directory: OrchestratorAgent[];
  thread_id: string;
  dispatch: (
    agent: OrchestratorAgent,
    task: WorkerTask,
    thread_id: string
  ) => Promise<DispatchedResult | null>;
}

export interface RunOrchestratorResult {
  rationale: string;
  topology: OrchestratorTopology;
  results: DispatchedResult[];
  reply: { subject: string; reply: string };
}

/**
 * Execute a plan against the agent directory. Exported separately from
 * runOrchestrator so tests can drive specific topologies without round-
 * tripping through Claude.
 */
export async function executePlan(
  plan: OrchestratorPlan,
  params: RunOrchestratorParams
): Promise<DispatchedResult[]> {
  if (plan.topology === "single" || plan.subtasks.length === 0) {
    return [];
  }

  if (plan.topology === "pipeline") {
    // Sequential: each worker receives the previous worker's structured
    // output as additional context, enabling compare/contrast tasks.
    const results: DispatchedResult[] = [];
    for (const st of plan.subtasks) {
      const target = params.directory.find((a) => a.name === st.agent_name);
      if (!target) continue;

      const prior = results[results.length - 1];
      const hasPriorContext =
        prior && Object.keys(prior.structured).length > 0;
      const task: WorkerTask = hasPriorContext
        ? {
            ...st.task,
            instruction: `${st.task.instruction}\n\nContext from previous step (${prior.agent}):\n${safeStringify(
              prior.structured
            )}`,
          }
        : st.task;

      const result = await params.dispatch(target, task, params.thread_id);
      if (result) results.push(result);
    }
    return results;
  }

  // parallel (default): all subtasks dispatched concurrently.
  const dispatched = await Promise.all(
    plan.subtasks.map(async (st) => {
      const target = params.directory.find((a) => a.name === st.agent_name);
      if (!target) return null;
      return params.dispatch(target, st.task, params.thread_id);
    })
  );
  return dispatched.filter((r): r is DispatchedResult => Boolean(r));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export async function runOrchestrator(
  params: RunOrchestratorParams
): Promise<RunOrchestratorResult> {
  const plan = await orchestratorPlan(
    params.managerRequest,
    params.directory.map((a) => ({
      name: a.name,
      role: a.role,
      skills: a.skills,
    }))
  );

  const results = await executePlan(plan, params);
  const reply = await orchestratorAggregate(params.managerRequest, results);
  return { rationale: plan.rationale, topology: plan.topology, results, reply };
}
