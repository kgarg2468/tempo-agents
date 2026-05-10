/**
 * Router: dispatches a message to a recipient using the right transport
 * (AgentMail for human↔agent + cross-org, A2A JSON-RPC for inside-system
 * agent↔agent). Always shadow-CCs a manager email so the audit trail lives
 * in one inbox, regardless of transport.
 */

import { sendEmail } from "./agentmail";
import { sendMessage } from "./a2a";

export interface RouteRecipient {
  address: string; // email = identity
  a2a_endpoint_url?: string; // present if agent has an A2A endpoint
  is_human: boolean;
}

export interface RouteOutboundParams {
  thread_id: string;
  subject: string;
  body: string;
  sender: { address: string; from_label?: string };
  to: RouteRecipient;
  ccHumans?: string[]; // always at least manager when an agent is involved
  preferA2A?: boolean;
}

export interface RouteResult {
  transport: "email" | "a2a";
  external_id: string;
  cc_email_id?: string;
}

/**
 * Send + record. Convex action callers should persist the result via
 * threads.appendMessage().
 */
export async function routeOutbound(
  params: RouteOutboundParams
): Promise<RouteResult> {
  const useA2A =
    params.preferA2A === true &&
    !params.to.is_human &&
    typeof params.to.a2a_endpoint_url === "string" &&
    params.to.a2a_endpoint_url.length > 0;

  if (useA2A) {
    const task = await sendMessage(params.to.a2a_endpoint_url!, {
      text: params.body,
      contextId: params.thread_id,
    });
    const a2aId = task?.id ?? `a2a_failover_${Date.now()}`;

    let ccId: string | undefined;
    if (params.ccHumans && params.ccHumans.length) {
      try {
        const cc = await sendEmail({
          to: params.ccHumans[0],
          cc: params.ccHumans.slice(1),
          from: params.sender.address,
          subject: `[A2A audit] ${params.subject}`,
          body:
            `(Shadow audit copy of an A2A message between digital employees.)\n\n` +
            params.body,
          thread_id: params.thread_id,
        });
        ccId = cc.message_id;
      } catch (err) {
        console.warn("[router] shadow CC email failed:", err);
      }
    }

    return { transport: "a2a", external_id: a2aId, cc_email_id: ccId };
  }

  const cc = params.ccHumans?.filter((a) => a !== params.to.address);
  const sent = await sendEmail({
    to: params.to.address,
    cc,
    from: params.sender.address,
    subject: params.subject,
    body: params.body,
    thread_id: params.thread_id,
  });
  return { transport: "email", external_id: sent.message_id };
}
