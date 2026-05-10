import { Badge } from "@/components/ui/badge";

export interface NiaEvidenceSource {
  type: string;
  name: string;
  summary: string;
}

export function NiaEvidencePanel({
  sourcesIndexed,
  freshness,
  sources,
  signals,
}: {
  sourcesIndexed?: number;
  freshness?: number;
  sources: NiaEvidenceSource[];
  signals?: string[];
}) {
  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-widest text-orange-400">
          Nia Evidence Packet
        </h3>
        <div className="flex gap-2 text-[10px] font-mono text-zinc-500">
          {typeof sourcesIndexed === "number" ? (
            <span>{sourcesIndexed} indexed</span>
          ) : null}
          {freshness ? (
            <span>fresh {new Date(freshness).toLocaleTimeString()}</span>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {sources.map((s, i) => (
          <Badge key={`${s.type}-${i}`} variant="default" className="text-[10px]">
            {s.type}: {s.name}
          </Badge>
        ))}
      </div>

      {signals && signals.length ? (
        <ul className="text-xs text-zinc-300 space-y-1 list-disc pl-4">
          {signals.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}

      {sources.length ? (
        <details className="text-xs text-zinc-400">
          <summary className="cursor-pointer text-zinc-500">
            view raw source summaries
          </summary>
          <div className="mt-2 space-y-2">
            {sources.map((s, i) => (
              <div key={i} className="text-zinc-400">
                <span className="text-zinc-500">[{s.type}]</span> {s.name}
                <p className="text-zinc-300 ml-2">{s.summary}</p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
