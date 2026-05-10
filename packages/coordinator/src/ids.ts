import { createHash } from "node:crypto";

export function repoIdFor(repoRoot: string): string {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 16);
}

export function worktreeIdFor(worktreePath: string): string {
  return createHash("sha1").update(worktreePath).digest("hex").slice(0, 16);
}

export function stableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join(":")).digest("hex").slice(0, 16);
}

