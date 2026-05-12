import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  findGitRoot,
  hashNormalizedDiff,
  listWorktrees,
  normalizeDiff
} from "./git.js";

async function createRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "tempo-git-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "tempo@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Tempo Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await execa("git", ["add", "README.md"], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return realpath(dir);
}

describe("git helpers", () => {
  it("finds the git root from a nested path", async () => {
    const repo = await createRepo();
    const nested = path.join(repo, "src", "app");
    await execa("mkdir", ["-p", nested]);

    await expect(findGitRoot(nested)).resolves.toBe(repo);
  });

  it("parses git worktree list porcelain output", async () => {
    const repo = await createRepo();
    const sibling = path.join(path.dirname(repo), `tempo-wt-a-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", sibling], { cwd: repo });

    const worktrees = await listWorktrees(repo);

    expect(worktrees.map((worktree) => worktree.path).sort()).toEqual(
      [repo, sibling].sort()
    );
    expect(worktrees.find((worktree) => worktree.path === sibling)?.branch).toBe(
      "agent-a"
    );
  });

  it("normalizes and hashes diffs deterministically", () => {
    const diff = [
      "diff --git a/src/db/schema.ts b/src/db/schema.ts",
      "index 0000000..1111111 100644",
      "--- a/src/db/schema.ts",
      "+++ b/src/db/schema.ts",
      "@@ -1 +1 @@",
      "-export type Task = { id: string }",
      "+export type Task = { id: string; priority: string }",
      ""
    ].join("\n");

    const normalized = normalizeDiff(diff);

    expect(normalized).not.toContain("index 0000000");
    expect(hashNormalizedDiff(normalized)).toBe(hashNormalizedDiff(normalized));
  });
});
