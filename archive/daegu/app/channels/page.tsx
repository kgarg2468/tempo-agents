"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

interface Thread {
  _id: string;
  thread_id: string;
  title: string;
  participants: string[];
  status: "open" | "paused" | "closed";
  created_at: number;
}

export default function ChannelsPage() {
  const list = useQuery(api.threads.list);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Channels</h1>
        <p className="text-sm text-zinc-400">
          Threads where humans and digital employees coordinate. Each
          channel = one Nia namespace; every message is auto-indexed so
          agents retrieve context per turn rather than carrying it.
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
            No channels yet. Hire a digital employee to spawn the first one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {(list as Thread[]).map((t) => (
            <Link key={t._id} href={`/channels/${encodeURIComponent(t.thread_id)}`}>
              <Card className="hover:border-orange-700/60 transition cursor-pointer">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold"># {t.title}</span>
                      <Badge variant={t.status === "open" ? "active" : "default"}>
                        {t.status}
                      </Badge>
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500 break-all">
                      {t.thread_id}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {t.participants.length} participants
                    </div>
                  </div>
                  <div className="text-[10px] text-zinc-600">
                    {new Date(t.created_at).toLocaleString()}
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
