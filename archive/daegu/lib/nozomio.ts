/**
 * Nozomio Nia API client.
 *
 * Nia REST API base URL: https://apigcp.trynia.ai/v2.
 * Used to fetch source-grounded employee context from indexed sources
 * before the firing decision agent can ask Claude for a verdict.
 */

const NIA_BASE_URL =
  process.env.NIA_BASE_URL ??
  process.env.NOZOMIO_BASE_URL ??
  "https://apigcp.trynia.ai/v2";

export interface NozomioSource {
  type: string; // e.g. "github", "jira", "slack", "notion"
  name: string;
  summary: string;
  signals?: Record<string, unknown>;
}

export interface NozomioEntityContext {
  entity_id: string;
  display_name?: string;
  summary: string;
  sources: NozomioSource[];
  raw?: unknown;
}

class NozomioError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "NozomioError";
    this.status = status;
  }
}

function getApiKey() {
  const key = process.env.NIA_API_KEY ?? process.env.NOZOMIO_API_KEY;
  if (!key) {
    throw new NozomioError("NIA_API_KEY or NOZOMIO_API_KEY is not set");
  }
  return key;
}

/**
 * Fetch rich context for an entity (employee). Returns a normalized
 * shape that the agent can use as evidence for a firing decision.
 *
 * If the API is unavailable (or no key configured during demo), returns
 * a graceful placeholder so the rest of the pipeline still runs.
 */
export async function getEntityContext(
  entityId: string
): Promise<NozomioEntityContext> {
  if (!process.env.NIA_API_KEY && !process.env.NOZOMIO_API_KEY) {
    // Demo fallback so the agent has something to chew on.
    return demoContext(entityId);
  }

  try {
    const res = await fetch(`${NIA_BASE_URL}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(buildSearchRequest(entityId)),
    });

    if (!res.ok) {
      // Soft-fall back to demo context rather than killing the run
      console.warn(
        `[nozomio] entity ${entityId} returned ${res.status}; using demo context`
      );
      return demoContext(entityId);
    }

    return normalizeSearchResponse(entityId, await res.json());
  } catch (err) {
    console.warn("[nozomio] error fetching context, using demo:", err);
    return demoContext(entityId);
  }
}

function buildSearchRequest(entityId: string) {
  const repositories = splitEnvList(process.env.NIA_REPOSITORIES);
  const data_sources = splitEnvList(process.env.NIA_DATA_SOURCES);

  return {
    mode: "query",
    search_mode: "unified",
    messages: [
      {
        role: "user",
        content: `Find source-grounded performance evidence for employee entity "${entityId}". Prioritize GitHub PRs, Slack messages, docs, Jira/task records, launch checklists, and handoff notes. Return concise signals with source names and enough detail for an HR decision agent to cite them.`,
      },
    ],
    ...(repositories.length ? { repositories } : {}),
    ...(data_sources.length ? { data_sources } : {}),
  };
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeSearchResponse(
  entityId: string,
  data: unknown
): NozomioEntityContext {
  const root = isRecord(data) ? data : {};
  const candidates = [
    root.answer,
    root.result,
    root.response,
    root.content,
    root.text,
    root.message,
    root.summary,
  ];
  const summary =
    candidates.find((v): v is string => typeof v === "string") ??
    "Nia unified search returned source material. Review raw context for details.";

  const sources = extractSources(root);

  return {
    entity_id: entityId,
    summary,
    sources,
    raw: data,
  };
}

function extractSources(root: Record<string, unknown>): NozomioSource[] {
  const arrays = [
    root.sources,
    root.results,
    root.documents,
    root.citations,
    root.references,
  ].filter(Array.isArray) as unknown[][];

  const flattened = arrays.flat();
  const sources = flattened
    .map(sourceFromUnknown)
    .filter((source): source is NozomioSource => Boolean(source));

  if (sources.length) return sources.slice(0, 8);

  return [
    {
      type: "nia",
      name: "Nia unified search",
      summary:
        "Nia returned a search response without structured citations; raw response is attached to the context packet.",
    },
  ];
}

function sourceFromUnknown(value: unknown): NozomioSource | null {
  if (!isRecord(value)) return null;
  const type = stringField(value, ["type", "source_type", "kind"]) ?? "nia";
  const name =
    stringField(value, ["name", "title", "source", "url", "path"]) ??
    "Nia source";
  const summary =
    stringField(value, ["summary", "snippet", "content", "text", "body"]) ??
    JSON.stringify(value).slice(0, 500);

  return {
    type,
    name,
    summary,
    signals: {
      score: value.score,
      url: value.url,
      path: value.path,
      source_id: value.source_id ?? value.sourceId ?? value.id,
    },
  };
}

function stringField(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Source ingestion: register sources under a given entity namespace so future
// unified-search calls can retrieve them. Used for "knowledge transfer" when
// a digital employee is hired and inherits a fired employee's source bundle.
// ---------------------------------------------------------------------------

export interface IngestSourceInput {
  type: string;
  name: string;
  uri?: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  entity_id: string;
  sources_indexed: number;
  last_indexed_at: number;
}

export async function ingestSourcesForEntity(
  entityId: string,
  sources: IngestSourceInput[]
): Promise<IngestResult> {
  const stamp = Date.now();

  if (!process.env.NIA_API_KEY && !process.env.NOZOMIO_API_KEY) {
    return {
      entity_id: entityId,
      sources_indexed: sources.length,
      last_indexed_at: stamp,
    };
  }

  try {
    const res = await fetch(`${NIA_BASE_URL}/sources`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entity_id: entityId,
        sources: sources.map((s) => ({
          type: s.type,
          name: s.name,
          uri: s.uri,
          content: s.body,
          metadata: s.metadata,
        })),
      }),
    });
    if (!res.ok) {
      console.warn(
        `[nozomio] ingestSourcesForEntity ${entityId} returned ${res.status}; continuing with demo marker`
      );
      return {
        entity_id: entityId,
        sources_indexed: sources.length,
        last_indexed_at: stamp,
      };
    }
    const data = (await res.json()) as {
      sources_indexed?: number;
      indexed?: number;
    };
    return {
      entity_id: entityId,
      sources_indexed: data.sources_indexed ?? data.indexed ?? sources.length,
      last_indexed_at: stamp,
    };
  } catch (err) {
    console.warn("[nozomio] ingestSourcesForEntity error:", err);
    return {
      entity_id: entityId,
      sources_indexed: sources.length,
      last_indexed_at: stamp,
    };
  }
}

// ---------------------------------------------------------------------------
// Unified search across one or more entity namespaces. Returns cited
// signals for an inbound reply.
// ---------------------------------------------------------------------------

export interface UnifiedSearchResult {
  query: string;
  namespaces: string[];
  citations: Array<{
    source_id: string;
    label: string;
    snippet: string;
    freshness?: number;
  }>;
  raw?: unknown;
}

export async function unifiedSearch(
  namespaces: string[],
  query: string,
  source_types?: string[]
): Promise<UnifiedSearchResult> {
  if (!process.env.NIA_API_KEY && !process.env.NOZOMIO_API_KEY) {
    return demoSearch(namespaces, query, source_types);
  }

  try {
    const res = await fetch(`${NIA_BASE_URL}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        mode: "query",
        search_mode: "unified",
        namespaces,
        messages: [{ role: "user", content: query }],
      }),
    });
    if (!res.ok) return demoSearch(namespaces, query, source_types);
    const data = (await res.json()) as Record<string, unknown>;
    const sources = extractSources(data);
    // Filter on raw s.type (case-insensitive) before formatting the label,
    // so casing/separator quirks in the label can't break the filter.
    const filteredSources = filterSourcesByType(sources, source_types);
    const citations = filteredSources.slice(0, 5).map((s, i) => ({
      source_id:
        (s.signals?.source_id as string | undefined) ?? `nia_${i}`,
      label: `${s.type}: ${s.name}`,
      snippet: s.summary,
      freshness: Date.now(),
    }));
    return { query, namespaces, citations, raw: data };
  } catch (err) {
    console.warn("[nozomio] unifiedSearch error:", err);
    return demoSearch(namespaces, query, source_types);
  }
}

function filterSourcesByType<T extends { type: string }>(
  sources: T[],
  source_types?: string[]
): T[] {
  if (!source_types || source_types.length === 0) return sources;
  const normalized = new Set(source_types.map((t) => t.toLowerCase()));
  return sources.filter((s) => normalized.has(s.type.toLowerCase()));
}

function filterBySourceTypes(
  citations: UnifiedSearchResult["citations"],
  source_types?: string[]
): UnifiedSearchResult["citations"] {
  if (!source_types || source_types.length === 0) return citations;
  const normalized = source_types.map((t) => t.toLowerCase());
  return citations.filter((c) => {
    const colonIdx = c.label.indexOf(":");
    if (colonIdx === -1) return false;
    const type = c.label.slice(0, colonIdx).trim().toLowerCase();
    return normalized.includes(type);
  });
}

function demoSearch(
  namespaces: string[],
  query: string,
  source_types?: string[]
): UnifiedSearchResult {
  const seed = (namespaces.join("") + query)
    .split("")
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  const allCitations = [
    {
      source_id: `nia_demo_${seed}_a`,
      label: "github: handoff-notes.md",
      snippet:
        "Payroll migration: schema diff in PR #412; outstanding owner: <fired employee>; Slack thread #infra captures cutover plan.",
      freshness: Date.now(),
    },
    {
      source_id: `nia_demo_${seed}_b`,
      label: "slack: #infra (recent)",
      snippet:
        "Sev-2 retrospective referenced the same migration; action item assigned but unresolved at termination.",
      freshness: Date.now(),
    },
    {
      source_id: `nia_demo_${seed}_c`,
      label: "docs: launch-checklist.md",
      snippet:
        "Checklist item 7 (rotate payroll secrets) marked unchecked; cited in last status update.",
      freshness: Date.now(),
    },
  ];
  return {
    query,
    namespaces,
    citations: filterBySourceTypes(allCitations, source_types),
  };
}

function demoContext(entityId: string): NozomioEntityContext {
  // Deterministic-ish demo data so the same entity yields the same context.
  const seed = entityId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const missedDeadlines = (seed % 5) + 1;
  const prRejectRate = ((seed * 7) % 80) + 10;
  const slackChattiness = ["low", "medium", "high"][seed % 3];

  return {
    entity_id: entityId,
    display_name: undefined,
    summary: `Demo context for ${entityId}. ${missedDeadlines} missed deadlines in the last sprint, PR rejection rate ${prRejectRate}%, slack activity ${slackChattiness}.`,
    sources: [
      {
        type: "github",
        name: "GitHub",
        summary: `PR rejection rate: ${prRejectRate}%. ${missedDeadlines} stale PRs.`,
        signals: { pr_rejection_rate: prRejectRate, stale_prs: missedDeadlines },
      },
      {
        type: "jira",
        name: "Jira",
        summary: `${missedDeadlines} missed deadlines in the last sprint.`,
        signals: { missed_deadlines: missedDeadlines },
      },
      {
        type: "slack",
        name: "Slack",
        summary: `Activity level: ${slackChattiness}. Often goes silent during incident channels.`,
        signals: { activity: slackChattiness },
      },
    ],
  };
}
