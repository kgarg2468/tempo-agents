import { createHash } from "node:crypto";
import type { Fingerprint } from "@tempo/shared";
import { fingerprintSchema } from "@tempo/shared";
import {
  extractSurfacesFromDiff,
  type FileSnapshot
} from "./indexer.js";

export interface HeuristicFingerprintInput {
  repoId: string;
  worktreeId: string;
  diffHash: string;
  files: FileSnapshot[];
  createdAt?: number;
}

export function createHeuristicFingerprint(
  input: HeuristicFingerprintInput
): Fingerprint {
  const surfaces = extractSurfacesFromDiff({ files: input.files });
  const symbols = extractSymbols(input.files);
  const surfaceLabels = surfaces.map((surface) => surface.label);
  const semanticSummary =
    surfaceLabels.length > 0
      ? `Changes touch ${surfaceLabels.join(", ")}.`
      : `Changes touch ${input.files.map((file) => file.path).join(", ")}.`;
  const fingerprint: Fingerprint = {
    id: fingerprintId(input.worktreeId, input.diffHash),
    repoId: input.repoId,
    worktreeId: input.worktreeId,
    diffHash: input.diffHash,
    createdAt: input.createdAt ?? Date.now(),
    filesTouched: input.files.map((file) => file.path).sort(),
    symbols,
    surfaces,
    semanticSummary,
    contractChanges: surfaceLabels,
    confidence: surfaces.length > 0 ? 0.72 : 0.45,
    source: "heuristic"
  };

  return fingerprintSchema.parse(fingerprint);
}

function extractSymbols(files: FileSnapshot[]): Fingerprint["symbols"] {
  const modified = new Set<string>();
  const patterns = [
    /\binterface\s+([A-Z][A-Za-z0-9_]*)/g,
    /\btype\s+([A-Z][A-Za-z0-9_]*)/g,
    /\bclass\s+([A-Z][A-Za-z0-9_]*)/g,
    /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bpublic\s+(?:class|interface|record)\s+([A-Z][A-Za-z0-9_]*)/g
  ];

  for (const file of files) {
    for (const pattern of patterns) {
      for (const match of file.content.matchAll(pattern)) {
        if (match[1]) modified.add(match[1]);
      }
    }
  }

  return {
    added: [],
    modified: [...modified].sort(),
    removed: []
  };
}

function fingerprintId(worktreeId: string, diffHash: string): string {
  return createHash("sha1").update(`${worktreeId}:${diffHash}`).digest("hex").slice(0, 16);
}

