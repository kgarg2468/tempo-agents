import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export function repoIdFor(repoRoot: string): string {
  return createHash("sha1")
    .update(canonicalPath(repoRoot))
    .digest("hex")
    .slice(0, 16);
}

export function worktreeIdFor(worktreePath: string): string {
  return createHash("sha1")
    .update(canonicalPath(worktreePath))
    .digest("hex")
    .slice(0, 16);
}

export function stableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join(":")).digest("hex").slice(0, 16);
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch (_error) {
    return path.resolve(filePath);
  }
}
