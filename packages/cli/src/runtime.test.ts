import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  checkRocketRideRuntime,
  loadTempoEnv,
  parseTempoEnv,
  prepareRuntime,
  readRuntimeState
} from "./runtime.js";

async function createRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "tempo-cli-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await execa("git", ["add", "README.md"], { cwd: dir });
  await execa("git", ["config", "user.email", "tempo@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Tempo Test"], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
  return realpath(dir);
}

describe("prepareRuntime", () => {
  it("creates repo-local runtime state without repo-visible changes by default", async () => {
    const repo = await createRepo();

    const runtime = await prepareRuntime({
      cwd: repo,
      prompts: {
        updateGitignore: false,
        updateAgents: false
      }
    });

    expect(runtime.repoRoot).toBe(repo);
    expect(runtime.coordinatorUrl).toBe("http://127.0.0.1:3747");
    expect(runtime.dashboardUrl).toBe("http://127.0.0.1:3748");
    expect(runtime.mcpUrl).toBe("http://127.0.0.1:3747/mcp");
    await expect(readFile(path.join(repo, ".tempo", "runtime.json"), "utf8")).resolves.toContain(
      runtime.token
    );
    await expect(readFile(path.join(repo, ".tempo", ".gitignore"), "utf8")).resolves.toContain(
      "*"
    );
    await expect(
      readFile(path.join(repo, ".tempo", "hooks", "codex-hook.mjs"), "utf8")
    ).resolves.toContain("/api/hooks/codex");
    await expect(readFile(path.join(repo, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("adds marked setup blocks and privacy ignore only when prompted", async () => {
    const repo = await createRepo();

    await prepareRuntime({
      cwd: repo,
      prompts: {
        updateGitignore: true,
        updateAgents: true,
        updateTempoIgnore: true
      }
    });

    await expect(readFile(path.join(repo, ".gitignore"), "utf8")).resolves.toContain(
      ".tempo/"
    );
    await expect(readFile(path.join(repo, "AGENTS.md"), "utf8")).resolves.toContain(
      "BEGIN TEMPO"
    );
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("if `tempo_wait_for_direction` times out with `keepWaiting: true`");
    expect(agents).toContain("When Tempo returns `choices`, show the numbered options and keep polling");
    expect(agents).toContain("If another session records the decision");
    expect(agents).toContain("call `tempo_acknowledge_intervention`");
    expect(agents).toContain("rely on Tempo hooks");
    expect(agents).toContain("tempo mcp checkpoint --json");
    await expect(readFile(path.join(repo, ".tempoignore"), "utf8")).resolves.toContain(
      "Tempo privacy ignore"
    );
  });

  it("loads repo-local Tempo env without overriding existing shell env", async () => {
    const repo = await createRepo();
    const runtime = await prepareRuntime({
      cwd: repo,
      prompts: {
        updateGitignore: false,
        updateAgents: false
      }
    });
    await writeFile(
      runtime.envPath,
      [
        "OPENAI_API_KEY=from-file",
        "OPENAI_MODEL=\"gpt-5.4-mini\"",
        "TEMPO_LOCAL_TOKEN=from-file",
        ""
      ].join("\n")
    );
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "from-shell"
    };

    await loadTempoEnv(runtime.envPath, env);

    expect(env.OPENAI_API_KEY).toBe("from-shell");
    expect(env.OPENAI_MODEL).toBe("gpt-5.4-mini");
    expect(env.TEMPO_LOCAL_TOKEN).toBe("from-file");
  });

  it("loads project .env before .tempo env so project OpenAI keys are usable", async () => {
    const repo = await createRepo();
    const runtime = await prepareRuntime({
      cwd: repo,
      prompts: {
        updateGitignore: false,
        updateAgents: false
      }
    });
    await writeFile(
      path.join(repo, ".env"),
      ["OPENAI_API_KEY=from-project", "OPENAI_MODEL=gpt-5.4-mini", ""].join("\n")
    );
    await writeFile(
      runtime.envPath,
      ["OPENAI_API_KEY=from-runtime", "TEMPO_LOCAL_TOKEN=from-runtime", ""].join("\n")
    );
    const env: Record<string, string | undefined> = {};

    await loadTempoEnv(path.join(repo, ".env"), env);
    await loadTempoEnv(runtime.envPath, env);

    expect(env.OPENAI_API_KEY).toBe("from-project");
    expect(env.TEMPO_LOCAL_TOKEN).toBe("from-runtime");
  });

  it("reads existing runtime state without starting the coordinator", async () => {
    const repo = await createRepo();
    const runtime = await prepareRuntime({
      cwd: repo,
      prompts: {
        updateGitignore: false,
        updateAgents: false
      }
    });

    await expect(readRuntimeState(repo)).resolves.toMatchObject({
      repoRoot: repo,
      hookPath: runtime.hookPath,
      token: runtime.token
    });
  });

  it("reads the shared runtime from a linked git worktree", async () => {
    const repo = await createRepo();
    const runtime = await prepareRuntime({
      cwd: repo,
      prompts: {
        updateGitignore: false,
        updateAgents: false
      }
    });
    const worktreeParent = await mkdtemp(path.join(tmpdir(), "tempo-cli-worktrees-"));
    const worktree = path.join(worktreeParent, "feature");
    await rm(worktree, { recursive: true, force: true });
    await execa("git", ["worktree", "add", "-b", "feature", worktree, "HEAD"], {
      cwd: repo
    });

    await expect(readRuntimeState(worktree)).resolves.toMatchObject({
      repoRoot: repo,
      dataDir: runtime.dataDir,
      hookPath: runtime.hookPath,
      token: runtime.token
    });
  });

  it("parses simple dotenv syntax", () => {
    expect(
      parseTempoEnv([
        "# comment",
        "OPENAI_API_KEY='sk-test'",
        "OPENAI_MODEL=gpt-5.4-mini # model comment",
        "EMPTY=",
        ""
      ].join("\n"))
    ).toEqual({
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-5.4-mini",
      EMPTY: ""
    });
  });

  it("preflights RocketRide using ROCKETRIDE_URI and reports a clear offline result", async () => {
    const result = await checkRocketRideRuntime({
      rocketRideUri: "http://127.0.0.1:9",
      apiKey: "",
      fetchImpl: async () => {
        throw new TypeError("connection refused");
      }
    });

    expect(result).toEqual({
      ok: false,
      uri: "http://127.0.0.1:9",
      message:
        "RocketRide is offline at http://127.0.0.1:9. Start RocketRide locally or set ROCKETRIDE_URI."
    });
  });

  it("preflights RocketRide through the SDK when an API key is configured", async () => {
    const calls: string[] = [];

    const result = await checkRocketRideRuntime({
      rocketRideUri: "ws://127.0.0.1:5565",
      apiKey: "rr-local",
      clientFactory: () => ({
        async connect() {
          calls.push("connect");
        },
        async ping() {
          calls.push("ping");
        },
        async disconnect() {
          calls.push("disconnect");
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("SDK ping succeeded");
    expect(calls).toEqual(["connect", "ping", "disconnect"]);
  });

  it("fails closed quickly when the RocketRide SDK connection hangs", async () => {
    const result = await checkRocketRideRuntime({
      rocketRideUri: "http://127.0.0.1:5599",
      apiKey: "rr-local",
      timeoutMs: 5,
      clientFactory: () => ({
        async connect() {
          await new Promise(() => undefined);
        },
        async ping() {
          throw new Error("unreachable");
        },
        async disconnect() {}
      }),
      fetchImpl: async () => {
        return await new Promise(() => undefined);
      }
    });

    expect(result).toEqual({
      ok: false,
      uri: "http://127.0.0.1:5599",
      message:
        "RocketRide SDK ping timed out at http://127.0.0.1:5599. Start RocketRide locally or set ROCKETRIDE_URI."
    });
  });
});
