/**
 * Minimal A2A (Agent-to-Agent Protocol) client + types.
 * Spec: https://github.com/a2aproject/A2A — JSON-RPC 2.0 over HTTPS.
 *
 * We implement only the two methods we need for the demo:
 *   - message/send
 *   - tasks/get
 *
 * Streaming (`message/stream`) and push notifications are out of scope.
 */

export interface AgentCardSkill {
  id: string;
  name: string;
  description?: string;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string; // JSON-RPC endpoint
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: AgentCardSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface A2AMessagePart {
  kind: "text" | "data";
  text?: string;
  data?: unknown;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2AMessagePart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}

export interface A2ATaskStatus {
  state: "submitted" | "working" | "completed" | "failed" | "canceled";
  message?: A2AMessage;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: Array<{
    artifactId: string;
    name?: string;
    parts: A2AMessagePart[];
  }>;
  history?: A2AMessage[];
  kind: "task";
}

export interface JsonRpcRequest<P> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: P;
}

export interface JsonRpcResponse<R> {
  jsonrpc: "2.0";
  id: string | number;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export function newRpcId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface WorkerTaskBundle {
  data_query: {
    namespaces: string[];
    source_types?: string[];
  };
  output_schema: {
    required_fields: string[];
  };
}

export interface SendMessageInput {
  text: string;
  contextId?: string;
  taskId?: string;
  workerTask?: WorkerTaskBundle;
}

export async function sendMessage(
  endpointUrl: string,
  input: SendMessageInput
): Promise<A2ATask | null> {
  const parts: A2AMessagePart[] = [{ kind: "text", text: input.text }];
  if (input.workerTask) {
    parts.push({ kind: "data", data: input.workerTask });
  }
  const message: A2AMessage = {
    role: "user",
    parts,
    messageId: newMessageId(),
    taskId: input.taskId,
    contextId: input.contextId,
  };

  const body: JsonRpcRequest<{ message: A2AMessage }> = {
    jsonrpc: "2.0",
    id: newRpcId(),
    method: "message/send",
    params: { message },
  };

  try {
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(
        `[a2a] sendMessage ${endpointUrl} returned ${res.status}`
      );
      return null;
    }
    const data = (await res.json()) as JsonRpcResponse<A2ATask>;
    if (data.error) {
      console.warn(`[a2a] sendMessage error: ${data.error.message}`);
      return null;
    }
    return data.result ?? null;
  } catch (err) {
    console.warn("[a2a] sendMessage failed:", err);
    return null;
  }
}

export async function getTask(
  endpointUrl: string,
  taskId: string
): Promise<A2ATask | null> {
  const body: JsonRpcRequest<{ id: string }> = {
    jsonrpc: "2.0",
    id: newRpcId(),
    method: "tasks/get",
    params: { id: taskId },
  };
  try {
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as JsonRpcResponse<A2ATask>;
    return data.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Build an A2A agent card document from minimal inputs.
 */
export function buildAgentCard(input: {
  name: string;
  description: string;
  url: string;
  skills?: AgentCardSkill[];
}): AgentCard {
  return {
    name: input.name,
    description: input.description,
    url: input.url,
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    skills:
      input.skills ??
      [
        {
          id: "answer",
          name: "Answer questions with cited Nia evidence",
        },
        {
          id: "handoff",
          name: "Hand off work to other digital employees",
        },
      ],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}

/**
 * Helper: extract first text part from a message.
 */
export function messageText(msg: A2AMessage | undefined | null): string {
  if (!msg) return "";
  return msg.parts
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
}
