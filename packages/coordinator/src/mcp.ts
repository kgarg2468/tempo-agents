import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { createMcpToolHandlers, type McpToolContext } from "./mcp-tools.js";

export function registerTempoMcp(app: FastifyInstance, context: McpToolContext): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (request, reply) => {
    if (!(await authorizeMcpRequest(request, reply))) return;

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && !sessionId && isInitializeRequest(request.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (transport) transports.set(newSessionId, transport);
        }
      });
      transport.onclose = () => {
        const closedSessionId = transport?.sessionId;
        if (closedSessionId) transports.delete(closedSessionId);
      };
      const server = createTempoMcpServer(context);
      await server.connect(transport as Parameters<typeof server.connect>[0]);
    }

    if (!transport) {
      await reply.code(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid MCP session"
        },
        id: null
      });
      return;
    }

    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.hijack();
  });

  app.get("/mcp", async (request, reply) => {
    if (!(await authorizeMcpRequest(request, reply))) return;
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      await reply.code(400).send("Invalid or missing MCP session ID");
      return;
    }
    await transport.handleRequest(request.raw, reply.raw);
    reply.hijack();
  });

  app.delete("/mcp", async (request, reply) => {
    if (!(await authorizeMcpRequest(request, reply))) return;
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      await reply.code(400).send("Invalid or missing MCP session ID");
      return;
    }
    await transport.handleRequest(request.raw, reply.raw);
    reply.hijack();
  });
}

function createTempoMcpServer(context: McpToolContext): McpServer {
  const handlers = createMcpToolHandlers(context);
  const server = new McpServer({
    name: "tempo",
    version: "0.1.0"
  });

  server.registerTool(
    "tempo_join",
    {
      title: "Join Tempo",
      description: "Register this coding session with Tempo for the current repo.",
      inputSchema: {
        cwd: z.string().describe("Current working directory for this agent session."),
        agentKind: z.enum(["codex", "claude", "unknown"]).default("codex"),
        coordinationRole: z.enum(["feature", "integration"]).default("feature"),
        displayName: z.string().optional()
      }
    },
    async (input) =>
      textResult(
        handlers.join({
          cwd: input.cwd,
          agentKind: input.agentKind,
          coordinationRole: input.coordinationRole,
          ...(input.displayName ? { displayName: input.displayName } : {})
        })
      )
  );

  server.registerTool(
    "tempo_plan",
    {
      title: "Submit Tempo Plan",
      description: "Tell Tempo the intended work before meaningful edits.",
      inputSchema: {
        sessionId: z.string(),
        plan: z.string()
      }
    },
    async (input) => textResult(handlers.plan(input))
  );

  server.registerTool(
    "tempo_checkpoint",
    {
      title: "Tempo Checkpoint",
      description:
        "Check current Tempo risk, unread notifications, coordination episodes, and work orders.",
      inputSchema: {
        sessionId: z.string(),
        publishContract: z
          .object({
            conflictId: z.string().optional(),
            surface: z.string(),
            shapeSummary: z.string(),
            files: z.array(z.string()).optional()
          })
          .optional()
      }
    },
    async (input) => textResult(handlers.checkpoint(input))
  );

  server.registerTool(
    "tempo_publish_contract",
    {
      title: "Publish Tempo Contract",
      description:
        "Publish the canonical contract for this session's active coordination episode. Tempo infers the conflict when one active episode matches.",
      inputSchema: {
        sessionId: z.string(),
        conflictId: z.string().optional(),
        surface: z.string(),
        shapeSummary: z.string(),
        files: z.array(z.string()).optional()
      }
    },
    async (input) =>
      textResult(
        handlers.checkpoint({
          sessionId: input.sessionId,
          publishContract: {
            ...(input.conflictId ? { conflictId: input.conflictId } : {}),
            surface: input.surface,
            shapeSummary: input.shapeSummary,
            ...(input.files ? { files: input.files } : {})
          }
        })
      )
  );

  server.registerTool(
    "tempo_session_state",
    {
      title: "Tempo Session State",
      description:
        "Return current session, local evidence packet id, active risks, queued directions, and queued work orders.",
      inputSchema: {
        sessionId: z.string()
      }
    },
    async (input) => textResult(handlers.sessionState(input))
  );

  server.registerTool(
    "tempo_collision_risk",
    {
      title: "Tempo Collision Risk",
      description:
        "Return current Tempo collision risk with debate verdicts and cloud packet ids.",
      inputSchema: {
        sessionId: z.string().optional()
      }
    },
    async (input) => textResult(handlers.collisionRisk(input))
  );

  server.registerTool(
    "tempo_fetch_intervention",
    {
      title: "Fetch Tempo Intervention",
      description:
        "Fetch user-approved advisory directions and delegated work orders queued for this session.",
      inputSchema: {
        sessionId: z.string()
      }
    },
    async (input) => textResult(handlers.fetchIntervention(input))
  );

  server.registerTool(
    "tempo_wait_for_direction",
    {
      title: "Wait For Tempo Direction",
      description:
        "Wait briefly for a user-approved dashboard/chat direction or delegated work order for this session.",
      inputSchema: {
        sessionId: z.string(),
        timeoutMs: z.number().int().min(0).max(120000).optional()
      }
    },
    async (input) => textResult(await handlers.waitForDirection(input))
  );

  server.registerTool(
    "tempo_record_decision",
    {
      title: "Record Tempo Decision",
      description:
        "Record a user-approved conflict choice and queue complementary agent directions.",
      inputSchema: {
        sessionId: z.string().optional(),
        conflictId: z.string(),
        selectedOptionId: z.string(),
        selectedOptionTitle: z.string(),
        selectedOptionDirection: z.string(),
        ownerAgentSessionId: z.string().optional(),
        createdBy: z.enum(["dashboard", "agent"]).default("agent")
      }
    },
    async (input) => textResult(handlers.recordDecision(input))
  );

  server.registerTool(
    "tempo_acknowledge_intervention",
    {
      title: "Acknowledge Tempo Intervention",
      description:
        "Mark a fetched Tempo direction as acknowledged after presenting the plan.",
      inputSchema: {
        sessionId: z.string(),
        interventionId: z.string()
      }
    },
    async (input) => textResult(handlers.acknowledgeIntervention(input))
  );

  return server;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function authorizeMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const header = request.headers.authorization;
  const actual =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;
  if (actual !== request.server.tempo.token) {
    await reply.code(401).send({ error: "Tempo local token required" });
    return false;
  }
  return true;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
