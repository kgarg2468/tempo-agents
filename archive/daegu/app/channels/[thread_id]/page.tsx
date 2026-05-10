"use client";

import { use, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentAvatar } from "@/components/agent-avatar";
import { CitationList } from "@/components/citation-chip";
import Link from "next/link";
import { Loader2, Send } from "lucide-react";

interface ThreadDoc {
  _id: string;
  thread_id: string;
  title: string;
  participants: string[];
  status: "open" | "paused" | "closed";
}

interface Msg {
  _id: string;
  thread_id: string;
  transport: "email" | "a2a";
  direction: "inbound" | "outbound";
  sender: string;
  recipients: string[];
  subject?: string;
  body: string;
  citations: Array<{ source_id: string; label: string; freshness?: number }>;
  created_at: number;
}

interface DigitalEmployee {
  _id: string;
  name: string;
  agentmail_address: string;
  is_orchestrator: boolean;
}

export default function ChannelPage({
  params,
}: {
  params: Promise<{ thread_id: string }>;
}) {
  const { thread_id: rawId } = use(params);
  const thread_id = decodeURIComponent(rawId);

  const thread = useQuery(api.threads.get, { thread_id });
  const messages = useQuery(api.threads.messagesForThread, { thread_id });
  const agents = useQuery(api.digitalEmployees.list);

  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentByAddress = new Map<string, DigitalEmployee>();
  ((agents ?? []) as DigitalEmployee[]).forEach((a) =>
    agentByAddress.set(a.agentmail_address, a)
  );

  const send = async () => {
    if (!composer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Find first agent mention or first agent participant.
      const mention = composer.match(/@([\w.-]+)/);
      const participants = (thread as ThreadDoc | null)?.participants ?? [];
      let target: DigitalEmployee | undefined;
      if (mention) {
        const wanted = mention[1].toLowerCase();
        for (const a of (agents ?? []) as DigitalEmployee[]) {
          if (
            a.name.toLowerCase() === wanted ||
            a.agentmail_address.startsWith(wanted)
          ) {
            target = a;
            break;
          }
        }
      }
      if (!target) {
        for (const p of participants) {
          const a = agentByAddress.get(p);
          if (a) {
            target = a;
            break;
          }
        }
      }
      if (!target) {
        throw new Error(
          "No digital employee in this channel to address. Try @<name>."
        );
      }
      const res = await fetch(`/api/a2a/${target._id}`.replace(`/${target._id}`, ""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Use the agent's nozomio_entity_id derived endpoint
      });
      // Actually, post directly to the entity endpoint:
      void res;
      // Replace with entity_id-based call:
      const aFull = (agents ?? []).find(
        (x: DigitalEmployee) => x._id === target!._id
      ) as
        | (DigitalEmployee & { nozomio_entity_id: string })
        | undefined;
      if (!aFull) throw new Error("agent metadata missing");

      const sender =
        process.env.NEXT_PUBLIC_MANAGER_ADDRESS ?? "manager@openfire.local";

      const rpc = await fetch(`/api/a2a/${aFull.nozomio_entity_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "message/send",
          params: {
            sender,
            message: {
              role: "user",
              parts: [{ kind: "text", text: composer }],
              messageId: `ui_${Date.now()}`,
              contextId: thread_id,
            },
          },
        }),
      });
      if (!rpc.ok) {
        throw new Error(`RPC failed (${rpc.status})`);
      }
      setComposer("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (thread === undefined || messages === undefined) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-zinc-500">
          Loading…
        </CardContent>
      </Card>
    );
  }
  if (thread === null) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-zinc-500">
          Channel not found.
          <div className="mt-2">
            <Link href="/channels" className="text-orange-400 hover:underline">
              ← Back to channels
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const t = thread as ThreadDoc;
  const msgs = (messages ?? []) as Msg[];

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-6">
      <div className="space-y-4">
        <Link
          href="/channels"
          className="text-sm text-zinc-500 hover:text-orange-400 transition"
        >
          ← Channels
        </Link>

        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight"># {t.title}</h1>
          <div className="text-[10px] font-mono text-zinc-500 break-all">
            {t.thread_id}
          </div>
        </header>

        <div className="space-y-3">
          {msgs.map((m) => {
            const agent = agentByAddress.get(m.sender);
            const isHuman = !agent;
            return (
              <div key={m._id} className="flex gap-3">
                <AgentAvatar
                  name={agent?.name ?? m.sender}
                  isHuman={isHuman}
                  isOrchestrator={agent?.is_orchestrator}
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold">
                      {agent?.name ?? m.sender}
                    </span>
                    <Badge
                      variant="default"
                      className="text-[10px] uppercase"
                    >
                      {m.transport}
                    </Badge>
                    <Badge variant="default" className="text-[10px]">
                      {m.direction}
                    </Badge>
                    <span className="text-zinc-500">
                      {new Date(m.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  {m.subject ? (
                    <div className="text-xs text-zinc-400 italic">
                      {m.subject}
                    </div>
                  ) : null}
                  <pre className="whitespace-pre-wrap text-sm text-zinc-200 font-sans">
                    {m.body}
                  </pre>
                  <CitationList citations={m.citations ?? []} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">
            Compose · @mention an agent to address
          </div>
          <div className="flex gap-2">
            <Input
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder="@ada find the payroll handoff"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button onClick={send} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          {error ? (
            <div className="text-xs text-red-400">{error}</div>
          ) : null}
        </div>
      </div>

      <aside className="space-y-2">
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500">
          Members
        </h3>
        <div className="space-y-1.5">
          {t.participants.map((p) => {
            const agent = agentByAddress.get(p);
            return (
              <div key={p} className="flex items-center gap-2 text-xs">
                <AgentAvatar
                  name={agent?.name ?? p}
                  isHuman={!agent}
                  isOrchestrator={agent?.is_orchestrator}
                  size={20}
                />
                <span className="truncate">{agent?.name ?? p}</span>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
