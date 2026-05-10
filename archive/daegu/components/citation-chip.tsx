import { Badge } from "@/components/ui/badge";

export interface Citation {
  source_id: string;
  label: string;
  freshness?: number;
}

export function CitationChip({ citation }: { citation: Citation }) {
  const fresh = citation.freshness
    ? new Date(citation.freshness).toLocaleTimeString()
    : null;
  return (
    <Badge
      variant="default"
      className="font-mono text-[10px] gap-1"
      title={citation.source_id}
    >
      <span className="opacity-60">nia:</span>
      <span>{citation.label}</span>
      {fresh ? <span className="opacity-50">· {fresh}</span> : null}
    </Badge>
  );
}

export function CitationList({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {citations.map((c) => (
        <CitationChip key={c.source_id} citation={c} />
      ))}
    </div>
  );
}
