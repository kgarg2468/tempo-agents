"use client";

import { use } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agent-avatar";
import Link from "next/link";

interface DigitalEmployee {
  _id: string;
  name: string;
  role: string;
  agentmail_address: string;
  a2a_endpoint_url: string;
  nozomio_entity_id: string;
  is_orchestrator: boolean;
  status: "provisioning" | "active" | "retired";
  knowledge_stats: { sources_indexed: number; last_indexed_at: number };
  skills: string[];
}

export default function DigitalEmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const agent = useQuery(api.digitalEmployees.get, { id: id as never });

  if (agent === undefined) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-zinc-500">
          Loading…
        </CardContent>
      </Card>
    );
  }
  if (agent === null) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-zinc-500">
          Digital employee not found.
        </CardContent>
      </Card>
    );
  }

  const a = agent as DigitalEmployee;

  return (
    <div className="space-y-8">
      <Link
        href="/digital-employees"
        className="text-sm text-zinc-500 hover:text-orange-400 transition"
      >
        ← Roster
      </Link>

      <header className="flex items-start gap-4">
        <AgentAvatar
          name={a.name}
          isOrchestrator={a.is_orchestrator}
          size={56}
        />
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">{a.name}</h1>
            {a.is_orchestrator ? <Badge variant="fired">Orchestrator</Badge> : null}
            <Badge variant={a.status === "active" ? "active" : "pending"}>
              {a.status}
            </Badge>
          </div>
          <p className="text-zinc-400">{a.role}</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row k="AgentMail inbox" v={a.agentmail_address} mono />
          <Row k="A2A endpoint" v={a.a2a_endpoint_url} mono />
          <Row k="Nia entity_id" v={a.nozomio_entity_id} mono />
          <Row
            k="Agent card"
            v={
              <a
                href={`/api/a2a/${a.nozomio_entity_id}/agent.json`}
                className="text-orange-400 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                /api/a2a/{a.nozomio_entity_id}/agent.json
              </a>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Knowledge (Nia)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row
            k="Sources indexed"
            v={String(a.knowledge_stats.sources_indexed)}
          />
          <Row
            k="Last indexed"
            v={new Date(a.knowledge_stats.last_indexed_at).toLocaleString()}
          />
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">
              Skills
            </div>
            <div className="flex flex-wrap gap-1.5">
              {a.skills.map((s) => (
                <Badge key={s} variant="default">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  k,
  v,
  mono,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <div className="text-zinc-500 text-xs uppercase tracking-wider">{k}</div>
      <div className={mono ? "font-mono text-xs break-all" : ""}>{v}</div>
    </div>
  );
}
