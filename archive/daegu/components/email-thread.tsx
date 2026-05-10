"use client";

import { Badge } from "@/components/ui/badge";

export interface EmailMessage {
  _id: string;
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  from: string;
  created_at: number;
}

export function EmailThread({ messages }: { messages: EmailMessage[] }) {
  if (!messages.length) {
    return (
      <div className="border border-[var(--border)] bg-[var(--surface)] p-10 text-center">
        <p className="text-[11px] font-mono text-[var(--text-dim)]">No emails in this thread yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {messages.map((m) => (
        <div
          key={m._id}
          className="border border-[var(--border)] bg-[var(--surface)] flex overflow-hidden"
          style={{
            borderLeftColor: m.direction === "outbound" ? "var(--accent)" : "var(--blue)",
          }}
        >
          <div
            className="w-[3px] shrink-0"
            style={{
              background: m.direction === "outbound" ? "var(--accent)" : "var(--blue)",
            }}
          />
          <div className="flex-1 p-4 min-w-0">
            <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
              <div>
                <p className="text-[11px] font-mono font-semibold text-[var(--text)]">{m.subject}</p>
                <p className="text-[9px] font-mono text-[var(--text-dim)] mt-0.5">
                  {m.from} · {new Date(m.created_at).toLocaleString()}
                </p>
              </div>
              <Badge variant={m.direction === "outbound" ? "active" : "spared"}>
                {m.direction === "outbound" ? "Sent" : "Reply"}
              </Badge>
            </div>
            <pre className="whitespace-pre-wrap text-[11px] font-mono text-[var(--text-muted)] leading-relaxed">
{m.body}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}
