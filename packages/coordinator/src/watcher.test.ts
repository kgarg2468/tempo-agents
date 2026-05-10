import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createRebaseStore } from "./store.js";
import { createRebaseWatcher } from "./watcher.js";

async function createRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "rebase-watcher-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "rebase@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Rebase Test"], { cwd: dir });
  await mkdir(path.join(dir, "src", "db"), { recursive: true });
  await writeFile(
    path.join(dir, "src", "db", "schema.ts"),
    "export interface Task { id: string }\n"
  );
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("RebaseWatcher", () => {
  it("discovers worktrees and persists fingerprints/conflicts from a scan", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-watch-a-${path.basename(repo)}`);
    const wtB = path.join(path.dirname(repo), `rebase-watch-b-${path.basename(repo)}`);
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

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.scanOnce();

    expect(store.listWorktrees("repo-1")).toHaveLength(3);
    expect(store.listFingerprints("repo-1")).toHaveLength(2);
    expect(store.listConflicts("repo-1")[0]?.affectedSurfaces).toContain(
      "Task model"
    );
    expect(store.listAdvisories("repo-1")[0]?.options[0]?.title).toBe(
      "Agree contract first"
    );
    expect(store.listEvents("repo-1").map((event) => event.type)).toContain(
      "analysis.completed"
    );

    await watcher.stop();
    store.close();
  });

  it("marks removed git worktrees as missing on refresh", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-watch-a-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.refreshWorktrees();
    await execa("git", ["worktree", "remove", wtA], { cwd: repo });
    await watcher.refreshWorktrees();

    const removed = store
      .listWorktrees("repo-1")
      .find((worktree) => worktree.branch === "agent-a");
    expect(removed?.status).toBe("missing");

    await watcher.stop();
    store.close();
  });

  it("does not emit repeated activity events for unchanged dirty worktrees", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "src", "db", "schema.ts"),
      "export interface Task { id: string; priority: string }\n"
    );

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.refreshWorktrees();
    await watcher.refreshWorktrees();

    expect(
      store
        .listEvents("repo-1")
        .filter((event) => event.type === "worktree.activity")
    ).toHaveLength(1);

    await watcher.stop();
    store.close();
  });

  it("ignores generated and Rebase-private paths", () => {
    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: "/tmp/repo",
      repoId: "repo-1",
      store
    });

    expect(watcher.isIgnoredPath("/tmp/repo/.rebase/runtime.json")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/node_modules/pkg/index.js")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/next-env.d.ts")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/tsconfig.tsbuildinfo")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/data/todo.sqlite-wal")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/pnpm-debug.log")).toBe(true);
    expect(watcher.isIgnoredPath("/tmp/repo/src/schema.ts")).toBe(false);
    store.close();
  });

  it("treats ignored-only diffs as clean worktrees", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "next-env.d.ts"),
      "import \"./.next/types/routes.d.ts\";\n"
    );
    await execa("git", ["add", "next-env.d.ts"], { cwd: repo });
    await execa("git", ["commit", "-m", "add next env"], { cwd: repo });
    await writeFile(
      path.join(repo, "next-env.d.ts"),
      "import \"./.next/dev/types/routes.d.ts\";\n"
    );

    const store = createRebaseStore(":memory:");
    const watcher = createRebaseWatcher({
      repoRoot: repo,
      repoId: "repo-1",
      store,
      now: () => 1778000000000
    });

    await watcher.refreshWorktrees();

    expect(store.listWorktrees("repo-1")[0]?.dirty).toBe(false);

    await watcher.stop();
    store.close();
  });
});
