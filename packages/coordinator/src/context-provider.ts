import type { RebaseConflict } from "@rebase/shared";
import type { RebaseStore } from "./store.js";

export interface ContextProviderQuery {
  repoId: string;
  worktreeId?: string | undefined;
  files?: string[] | undefined;
  surfaces?: string[] | undefined;
  limit?: number | undefined;
}

export interface RebaseContextFact {
  id: string;
  kind: "surface" | "conflict" | "decision";
  label: string;
  source: "native" | "external";
  evidence: string[];
}

export interface ContextProviderResult {
  provider: string;
  enabled: boolean;
  facts: RebaseContextFact[];
  warnings: string[];
}

export interface ContextProvider {
  readonly name: string;
  readonly enabled: boolean;
  query(input: ContextProviderQuery): Promise<ContextProviderResult>;
}

export class NativeRebaseContextProvider implements ContextProvider {
  readonly name = "native-rebase";
  readonly enabled = true;

  constructor(private readonly store: RebaseStore) {}

  async query(input: ContextProviderQuery): Promise<ContextProviderResult> {
    const facts = [
      ...this.surfaceFacts(input),
      ...this.conflictFacts(input),
      ...this.decisionFacts(input)
    ].slice(0, input.limit ?? 20);
    return {
      provider: this.name,
      enabled: true,
      facts,
      warnings: []
    };
  }

  private surfaceFacts(input: ContextProviderQuery): RebaseContextFact[] {
    const files = new Set(input.files ?? []);
    const surfaces = new Set(input.surfaces ?? []);
    return this.store
      .listFingerprints(input.repoId)
      .filter(
        (fingerprint) =>
          !input.worktreeId || fingerprint.worktreeId === input.worktreeId
      )
      .flatMap((fingerprint) => fingerprint.surfaces)
      .filter((surface) => {
        if (files.size === 0 && surfaces.size === 0) return true;
        return (
          surface.files.some((file) => files.has(file)) || surfaces.has(surface.label)
        );
      })
      .map((surface) => ({
        id: `surface:${surface.id}`,
        kind: "surface" as const,
        label: surface.label,
        source: "native" as const,
        evidence: surface.evidence
      }));
  }

  private conflictFacts(input: ContextProviderQuery): RebaseContextFact[] {
    return this.store
      .listConflicts(input.repoId)
      .filter((conflict) => matchesConflict(input, conflict))
      .map((conflict) => ({
        id: `conflict:${conflict.id}`,
        kind: "conflict" as const,
        label: `${conflict.risk} risk: ${conflict.title}`,
        source: "native" as const,
        evidence: conflict.evidence
      }));
  }

  private decisionFacts(input: ContextProviderQuery): RebaseContextFact[] {
    const matchingConflictIds = new Set(
      this.store
        .listConflicts(input.repoId)
        .filter((conflict) => matchesConflict(input, conflict))
        .map((conflict) => conflict.id)
    );
    return this.store
      .listConflictDecisions(input.repoId)
      .filter(
        (decision) =>
          matchingConflictIds.size === 0 || matchingConflictIds.has(decision.conflictId)
      )
      .map((decision) => ({
        id: `decision:${decision.id}`,
        kind: "decision" as const,
        label: decision.selectedOptionTitle,
        source: "native" as const,
        evidence: [decision.selectedOptionDirection]
      }));
  }
}

export class DisabledExternalContextProvider implements ContextProvider {
  readonly enabled = false;

  constructor(readonly name: string) {}

  async query(_input: ContextProviderQuery): Promise<ContextProviderResult> {
    return {
      provider: this.name,
      enabled: false,
      facts: [],
      warnings: [
        "External context providers are disabled in Rebase V1 unless an ADR and Krish approval explicitly enable one."
      ]
    };
  }
}

function matchesConflict(
  input: ContextProviderQuery,
  conflict: RebaseConflict
): boolean {
  const surfaces = new Set(input.surfaces ?? []);
  if (input.worktreeId && !conflict.affectedWorktreeIds.includes(input.worktreeId)) {
    return false;
  }
  if (surfaces.size === 0) return true;
  return conflict.affectedSurfaces.some((surface) => surfaces.has(surface));
}
