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

  it("uses RocketRide fingerprint output as authoritative in required mode", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-a-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });
    await writeFile(
      path.join(wtA, "src", "db", "schema.ts"),
      "export interface Task { id: string; label: string }\n"
    );
    const rocketRideInputs: Record<string, unknown>[] = [];

    const result = await analyzeWorktreesOnce({
      repoRoot: repo,
      repoId: "repo-1",
      rocketRide: {
        status: () => ({
          mode: "required",
          ok: true,
          uri: "http://127.0.0.1:5565",
          pipelineStatus: "validated",
          authoritative: true,
          message: "RocketRide test runner"
        }),
        async runPipeline(_name, input) {
          rocketRideInputs.push(input);
          return {
            runId: "rr-fingerprint",
            output: {
              fingerprint: {
                ...fingerprintFromInput(input),
                semanticSummary: "RocketRide authoritative fingerprint",
                contractChanges: ["RocketRide saw Task.label"]
              }
            }
          };
        }
      }
    });

    expect(result.rocketRideRunIds).toEqual(["rr-fingerprint"]);
    expect(rocketRideInputs[0]?.createdAt).toEqual(expect.any(Number));
    expect(result.fingerprints).toHaveLength(1);
    expect(result.fingerprints[0]?.semanticSummary).toBe(
      "RocketRide authoritative fingerprint"
    );
    expect(result.conflicts).toEqual([]);
  });

  it("rejects invalid RocketRide fingerprint output in required mode", async () => {
    const repo = await createRepo();
    const wtA = path.join(path.dirname(repo), `rebase-a-${path.basename(repo)}`);
    await execa("git", ["worktree", "add", "-b", "agent-a", wtA], { cwd: repo });
    await writeFile(
      path.join(wtA, "src", "db", "schema.ts"),
      "export interface Task { id: string; label: string }\n"
    );

    await expect(
      analyzeWorktreesOnce({
        repoRoot: repo,
        repoId: "repo-1",
        rocketRide: {
          status: () => ({
            mode: "required",
            ok: true,
            uri: "http://127.0.0.1:5565",
            pipelineStatus: "validated",
            authoritative: true,
            message: "RocketRide test runner"
          }),
          async runPipeline() {
            return { runId: "rr-invalid", output: { ok: true } };
          }
        }
      })
    ).rejects.toThrow(
      "RocketRide rebase-fingerprint output did not match the required schema"
    );
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

function fingerprintFromInput(input: Record<string, unknown>) {
  return {
    id: `rr-${String(input.worktreeId)}`,
    repoId: String(input.repoId),
    worktreeId: String(input.worktreeId),
    diffHash: String(input.diffHash),
    createdAt: 1778000000000,
    filesTouched: ["src/db/schema.ts"],
    symbols: {
      added: ["Task.label"],
      modified: ["Task"],
      removed: []
    },
    surfaces: [
      {
        id: "surface-task",
        label: "Task model",
        kind: "type",
        files: ["src/db/schema.ts"],
        confidence: 0.9,
        evidence: ["Task type changed"]
      }
    ],
    semanticSummary: "RocketRide fingerprint",
    contractChanges: ["Task changed"],
    confidence: 0.9,
    source: "mixed"
  };
}
