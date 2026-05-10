import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { analyzeWorktreesOnce } from "./analyzer.js";

async function createRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "rebase-analyzer-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "rebase@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Rebase Test"], { cwd: dir });
  await execa("mkdir", ["-p", path.join(dir, "src", "db")]);
  await writeFile(
    path.join(dir, "src", "db", "schema.ts"),
    "export interface Task { id: string }\n"
  );
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return realpath(dir);
}

describe("worktree analyzer", () => {
  it("detects a live contract conflict across two dirty worktrees", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-a-${path.basename(repo)}`);
    const wtB = path.join(path.dirname(repo), `rebase-b-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });
    await execa("git", ["worktree", "add", "-b", "agent-b", wtB], { cwd: repo });

    await writeFile(
      path.join(wtA, "src", "db", "schema.ts"),
      "export interface Task { id: string; priority: string }\n"
    );
    await writeFile(
      path.join(wtB, "src", "db", "schema.ts"),
      "export interface Task { id: string; tags: string[] }\n"
    );

    const result = await analyzeWorktreesOnce({
      repoRoot: repo,
      repoId: "repo-1"
    });

    expect(result.fingerprints).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.affectedSurfaces).toContain("Task model");
  });

  it("ignores generated-only Next route type diffs", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "next-env.d.ts"),
      [
        "/// <reference types=\"next\" />",
        "/// <reference types=\"next/image-types/global\" />",
        "import \"./.next/types/routes.d.ts\";",
        ""
      ].join("\n")
    );
    await execa("git", ["add", "next-env.d.ts"], { cwd: repo });
    await execa("git", ["commit", "-m", "add next env"], { cwd: repo });
    await writeFile(
      path.join(repo, "next-env.d.ts"),
      [
        "/// <reference types=\"next\" />",
        "/// <reference types=\"next/image-types/global\" />",
        "import \"./.next/dev/types/routes.d.ts\";",
        ""
      ].join("\n")
    );

    const result = await analyzeWorktreesOnce({
      repoRoot: repo,
      repoId: "repo-1"
    });

    expect(result.fingerprints).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("honors repo .rebaseignore entries when analyzing diffs", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "generated"), { recursive: true });
    await writeFile(path.join(repo, ".rebaseignore"), "generated/\n");
    await writeFile(path.join(repo, "generated", "output.ts"), "export const value = 1;\n");
    await execa("git", ["add", ".rebaseignore", "generated/output.ts"], { cwd: repo });
    await execa("git", ["commit", "-m", "add generated fixture"], { cwd: repo });
    await writeFile(path.join(repo, "generated", "output.ts"), "export const value = 2;\n");

    const result = await analyzeWorktreesOnce({
      repoRoot: repo,
      repoId: "repo-1"
    });

    expect(result.fingerprints).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});
