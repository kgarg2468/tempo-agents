import { detectConflicts } from "@tempo/coordinator";
import type { Fingerprint } from "@tempo/shared";

export interface EvalFixture {
  id: string;
  language: "ts" | "js" | "py" | "java" | "other";
  expectedConflict: boolean;
  fingerprints: Array<{
    worktreeId: string;
    filesTouched: string[];
    surfaces: string[];
  }>;
}

export interface EvalCaseResult {
  id: string;
  expectedConflict: boolean;
  actualConflict: boolean;
  verdict: "true_positive" | "true_negative" | "false_positive" | "false_negative";
  latencyMs: number;
  evidence: string[];
}

export interface EvalRunResult {
  cases: EvalCaseResult[];
  metrics: {
    recall: number;
    falsePositiveRate: number;
    averageLatencyMs: number;
  };
}

export function runFixtureEvals(fixtures: EvalFixture[]): EvalRunResult {
  const cases = fixtures.map((fixture) => runFixture(fixture));
  const positives = cases.filter((item) => item.expectedConflict);
  const truePositives = cases.filter((item) => item.verdict === "true_positive");
  const controls = cases.filter((item) => !item.expectedConflict);
  const falsePositives = cases.filter((item) => item.verdict === "false_positive");
  return {
    cases,
    metrics: {
      recall: positives.length === 0 ? 1 : truePositives.length / positives.length,
      falsePositiveRate:
        controls.length === 0 ? 0 : falsePositives.length / controls.length,
      averageLatencyMs:
        cases.reduce((sum, item) => sum + item.latencyMs, 0) / Math.max(1, cases.length)
    }
  };
}

function runFixture(fixture: EvalFixture): EvalCaseResult {
  const started = performance.now();
  const conflicts = detectConflicts(
    fixture.fingerprints.map((fingerprint, index) =>
      toFingerprint(fixture, fingerprint, index)
    )
  );
  const latencyMs = Math.round(performance.now() - started);
  const actualConflict = conflicts.length > 0;
  return {
    id: fixture.id,
    expectedConflict: fixture.expectedConflict,
    actualConflict,
    verdict: verdict(fixture.expectedConflict, actualConflict),
    latencyMs,
    evidence: conflicts.flatMap((conflict) => conflict.evidence)
  };
}

function toFingerprint(
  fixture: EvalFixture,
  input: EvalFixture["fingerprints"][number],
  index: number
): Fingerprint {
  return {
    id: `${fixture.id}-${index}`,
    repoId: `fixture-${fixture.id}`,
    worktreeId: input.worktreeId,
    diffHash: `${fixture.id}-${index}`,
    createdAt: 1778000000000 + index,
    filesTouched: input.filesTouched,
    symbols: {
      added: [],
      modified: [],
      removed: []
    },
    surfaces: input.surfaces.map((surface) => ({
      id: surface.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: surface,
      kind: surface.toLowerCase().includes("model") ? "schema" : "unknown",
      files: input.filesTouched,
      confidence: 0.8,
      evidence: ["fixture"]
    })),
    semanticSummary: `Fixture touches ${input.surfaces.join(", ")}.`,
    contractChanges: input.surfaces,
    confidence: 0.8,
    source: "heuristic"
  };
}

function verdict(
  expectedConflict: boolean,
  actualConflict: boolean
): EvalCaseResult["verdict"] {
  if (expectedConflict && actualConflict) return "true_positive";
  if (!expectedConflict && !actualConflict) return "true_negative";
  if (!expectedConflict && actualConflict) return "false_positive";
  return "false_negative";
}

