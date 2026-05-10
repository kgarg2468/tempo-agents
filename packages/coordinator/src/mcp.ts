import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { createMcpToolHandlers, type McpToolContext } from "./mcp-tools.js";

export function registerRebaseMcp(app: FastifyInstance, context: McpToolContext): void {
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
      const server = createRebaseMcpServer(context);
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

function createRebaseMcpServer(context: McpToolContext): McpServer {
  const handlers = createMcpToolHandlers(context);
  const server = new McpServer({
    name: "rebase",
    version: "0.1.0"
  });

  server.registerTool(
    "rebase_join",
    {
      title: "Join Rebase",
      description: "Register this coding session with Rebase for the current repo.",
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
    "rebase_plan",
    {
      title: "Submit Rebase Plan",
      description: "Tell Rebase the intended work before meaningful edits.",
      inputSchema: {
        sessionId: z.string(),
        plan: z.string()
      }
    },
    async (input) => textResult(handlers.plan(input))
  );

  server.registerTool(
    "rebase_checkpoint",
    {
      title: "Rebase Checkpoint",
      description: "Check current Rebase risk and unread notifications.",
      inputSchema: {
        sessionId: z.string(),
        publishContract: z
          .object({
            conflictId: z.string(),
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
    "rebase_session_state",
    {
      title: "Rebase Session State",
      description:
        "Return current session, local evidence packet id, active risks, and queued directions.",
      inputSchema: {
        sessionId: z.string()
      }
    },
    async (input) => textResult(handlers.sessionState(input))
  );

  server.registerTool(
    "rebase_collision_risk",
    {
      title: "Rebase Collision Risk",
      description:
        "Return current Rebase collision risk with debate verdicts and cloud packet ids.",
      inputSchema: {
        sessionId: z.string().optional()
      }
    },
    async (input) => textResult(handlers.collisionRisk(input))
  );

  server.registerTool(
    "rebase_fetch_intervention",
    {
      title: "Fetch Rebase Intervention",
      description: "Fetch user-approved advisory direction queued for this session.",
      inputSchema: {
        sessionId: z.string()
      }
    },
    async (input) => textResult(handlers.fetchIntervention(input))
  );

  server.registerTool(
    "rebase_wait_for_direction",
    {
      title: "Wait For Rebase Direction",
      description:
        "Wait briefly for a user-approved dashboard or chat direction for this session.",
      inputSchema: {
        sessionId: z.string(),
        timeoutMs: z.number().int().min(0).max(120000).optional()
      }
    },
    async (input) => textResult(await handlers.waitForDirection(input))
  );

  server.registerTool(
    "rebase_record_decision",
    {
      title: "Record Rebase Decision",
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
    "rebase_acknowledge_intervention",
    {
      title: "Acknowledge Rebase Intervention",
      description:
        "Mark a fetched Rebase direction as acknowledged after presenting the plan.",
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
  if (actual !== request.server.rebase.token) {
    await reply.code(401).send({ error: "Rebase local token required" });
    return false;
  }
  return true;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
