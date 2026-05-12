import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitWorktree {
  path: string;
  headSha: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd
    });
    return stdout.trim();
  } catch (_error) {
    throw new Error(`Tempo must be run inside a git repository: ${cwd}`);
  }
}

export async function listWorktrees(repoRoot: string): Promise<GitWorktree[]> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot
  });
  return parseWorktreePorcelain(stdout);
}

export function parseWorktreePorcelain(output: string): GitWorktree[] {
  const blocks = output
    .split(/\n(?=worktree )/g)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split("\n");
    const state: GitWorktree = {
      path: "",
      headSha: null,
      branch: null,
      bare: false,
      detached: false
    };

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        state.path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        state.headSha = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        state.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        state.bare = true;
      } else if (line === "detached") {
        state.detached = true;
      }
    }

    return state;
  });
}

export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff"], {
    cwd: worktreePath,
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout;
}

export function normalizeDiff(diff: string): string {
  return diff
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      if (line.startsWith("index ")) return false;
      if (line.startsWith("similarity index ")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function hashNormalizedDiff(normalizedDiff: string): string {
  return createHash("sha256").update(normalizedDiff).digest("hex");
}

export function extractChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files].sort();
}

