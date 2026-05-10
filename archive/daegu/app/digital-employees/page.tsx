"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agent-avatar";
import Link from "next/link";

interface DigitalEmployee {
  _id: string;
  name: string;
  role: string;
  agentmail_address: string;
  a2a_endpoint_url: string;
  is_orchestrator: boolean;
  status: "provisioning" | "active" | "retired";
  knowledge_stats: { sources_indexed: number; last_indexed_at: number };
  skills: string[];
}

export default function DigitalEmployeesPage() {
  const list = useQuery(api.digitalEmployees.list);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Digital Employees</h1>
        <p className="text-sm text-zinc-400">
          Autonomous agents with provisioned AgentMail inboxes, A2A endpoints,
          and per-agent Nia knowledge namespaces.
        </p>
      </header>

      {list === undefined ? (
        <Card>
          <CardContent className="py-12 text-center text-zinc-500">
            Loading…
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-zinc-500">
            No digital employees yet. Hire one from a fired employee&apos;s page.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(list as DigitalEmployee[]).map((a) => (
            <Link key={a._id} href={`/digital-employees/${a._id}`}>
              <Card className="hover:border-orange-700/60 transition cursor-pointer">
                <CardContent className="p-4 flex items-start gap-3">
                  <AgentAvatar
                    name={a.name}
                    isOrchestrator={a.is_orchestrator}
                    size={40}
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{a.name}</span>
                      {a.is_orchestrator ? (
                        <Badge variant="fired">Orchestrator</Badge>
                      ) : null}
                      <Badge
                        variant={
                          a.status === "active"
                            ? "active"
                            : a.status === "provisioning"
                              ? "pending"
                              : "default"
                        }
                      >
                        {a.status}
                      </Badge>
                    </div>
                    <div className="text-xs text-zinc-400">{a.role}</div>
                    <div className="text-[10px] font-mono text-zinc-500 break-all">
                      {a.agentmail_address}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {a.knowledge_stats.sources_indexed} Nia sources ·{" "}
                      {a.skills.length} skills
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
