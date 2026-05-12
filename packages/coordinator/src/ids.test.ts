import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeIdFor } from "./ids.js";

describe("stable ids", () => {
  it("uses the same worktree id for symlinked and real paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tempo-id-"));
    const realWorktree = path.join(dir, "real-worktree");
    const linkedWorktree = path.join(dir, "linked-worktree");
    await mkdir(realWorktree);
    await symlink(realWorktree, linkedWorktree);

    expect(worktreeIdFor(linkedWorktree)).toBe(worktreeIdFor(realWorktree));
  });
});
