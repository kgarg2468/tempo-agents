#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createCoordinatorApp } from "@rebase/coordinator";
import {
  loadRebaseEnv,
  prepareRuntime,
  readRuntimeState,
  type RebaseRuntime
} from "./runtime.js";

async function main() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0]?.startsWith("-") ? "start" : rawArgs[0] ?? "start";
  const args = new Set(command === "start" ? rawArgs : rawArgs.slice(1));
  if (command === "init") {
    await runInit(args);
    return;
  }
  if (command === "status") {
    await runStatus();
    return;
  }
  if (command !== "start") {
    throw new Error(`Unknown Rebase command: ${command}`);
  }
  await runStart(args);
}

async function runStart(args: Set<string>) {
  const yes = args.has("--yes") || args.has("-y");
  const serverOnly = args.has("--server-only");
  const noDashboard = args.has("--no-dashboard") || serverOnly;
  const noOpen = args.has("--no-open") || serverOnly;
  const prompts = yes
    ? { updateGitignore: true, updateAgents: true }
    : await askSetupPrompts();

  const runtime = await prepareRuntime({
    cwd: process.cwd(),
    prompts
  });
  await loadRebaseEnv(runtime.envPath);
  const app = await createCoordinatorApp({
    repoRoot: runtime.repoRoot,
    dbPath: runtime.dbPath,
    token: runtime.token
  });

  await app.listen({
    host: "127.0.0.1",
    port: runtime.coordinatorPort
  });

  console.log(`Rebase coordinator: ${runtime.coordinatorUrl}`);
  console.log(`Rebase env file: ${runtime.envPath}`);
  let dashboardProcess: ReturnType<typeof spawn> | null = null;
  if (!noDashboard) {
    dashboardProcess = await startDashboard(runtime);
    if (dashboardProcess) {
      console.log(`Rebase dashboard: ${runtime.dashboardUrl}`);
    } else {
      console.log("Rebase dashboard: run `pnpm --filter @rebase/dashboard dev` from the Rebase repo.");
    }
  }
  console.log(`Rebase MCP endpoint: ${runtime.mcpUrl}`);
  console.log(
    `Codex MCP setup: codex mcp add rebase --url ${runtime.mcpUrl} --bearer-token-env-var REBASE_LOCAL_TOKEN`
  );
  console.log(`Set REBASE_LOCAL_TOKEN=${runtime.token}`);

  if (!noOpen) {
    const url = dashboardProcess ? runtime.dashboardUrl : runtime.coordinatorUrl;
    openBrowser(url).catch(() => {
      console.log(`Open ${url} in your browser.`);
    });
  }

  const shutdown = async () => {
    dashboardProcess?.kill("SIGTERM");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function runInit(args: Set<string>) {
  const yes = args.has("--yes") || args.has("-y");
  const prompts = yes
    ? { updateGitignore: true, updateAgents: true, updateRebaseIgnore: true }
    : await askSetupPrompts();
  const runtime = await prepareRuntime({
    cwd: process.cwd(),
    prompts
  });
  console.log(`Rebase initialized: ${runtime.dataDir}`);
  console.log(`Rebase hook script: ${runtime.hookPath}`);
  console.log(`Rebase MCP endpoint: ${runtime.mcpUrl}`);
  console.log(
    `Codex MCP setup: codex mcp add rebase --url ${runtime.mcpUrl} --bearer-token-env-var REBASE_LOCAL_TOKEN`
  );
  console.log(`Set REBASE_LOCAL_TOKEN=${runtime.token}`);
}

async function runStatus() {
  const runtime = await readRuntimeState(process.cwd());
  if (!runtime) {
    console.log("Rebase is not initialized in this repo. Run `rebase init`.");
    return;
  }
  await loadRebaseEnv(runtime.envPath);
  const [health, agents, conflicts, evidence] = await Promise.all([
    fetchJson<{ ok: boolean }>(`${runtime.coordinatorUrl}/health`).catch(() => null),
    fetchJson<{ agents: unknown[] }>(`${runtime.coordinatorUrl}/api/agents`).catch(
      () => null
    ),
    fetchJson<{ conflicts: Array<{ risk: string }> }>(
      `${runtime.coordinatorUrl}/api/conflicts`
    ).catch(() => null),
    fetchJson<{ evidencePackets: unknown[] }>(
      `${runtime.coordinatorUrl}/api/evidence`
    ).catch(() => null)
  ]);
  const riskCounts = { low: 0, medium: 0, high: 0 };
  for (const conflict of conflicts?.conflicts ?? []) {
    if (conflict.risk === "low" || conflict.risk === "medium" || conflict.risk === "high") {
      riskCounts[conflict.risk] += 1;
    }
  }
  console.log(`Rebase runtime: ${runtime.dataDir}`);
  console.log(`Coordinator: ${health?.ok ? "online" : "offline"} (${runtime.coordinatorUrl})`);
  console.log(`Dashboard: ${runtime.dashboardUrl}`);
  console.log(`MCP: ${runtime.mcpUrl}`);
  console.log(`Agents: ${agents?.agents.length ?? 0}`);
  console.log(
    `Risks: ${riskCounts.high} high, ${riskCounts.medium} medium, ${riskCounts.low} low`
  );
  console.log(`Evidence packets: ${evidence?.evidencePackets.length ?? 0}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Rebase status request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function startDashboard(
  runtime: RebaseRuntime
): Promise<ReturnType<typeof spawn> | null> {
  const dashboardDir = await findDashboardDir();
  if (!dashboardDir) return null;
  const child = spawn(
    "pnpm",
    [
      "--dir",
      dashboardDir,
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(runtime.dashboardPort)
    ],
    {
      env: {
        ...process.env,
        REBASE_COORDINATOR_URL: runtime.coordinatorUrl,
        NEXT_PUBLIC_REBASE_COORDINATOR_URL: runtime.coordinatorUrl,
        REBASE_LOCAL_TOKEN: runtime.token
      },
      stdio: "inherit"
    }
  );
  return child;
}

async function findDashboardDir(): Promise<string | null> {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(cliDir, "../../../apps/dashboard");
  try {
    await access(path.join(candidate, "package.json"));
    return candidate;
  } catch (_error) {
    return null;
  }
}

async function askSetupPrompts() {
  if (!process.stdin.isTTY) {
    return {
      updateGitignore: false,
      updateAgents: false,
      updateRebaseIgnore: false
    };
  }
  const rl = createInterface({ input, output });
  try {
    const updateGitignore = await askYesNo(
      rl,
      "Add .rebase/ to this repo's .gitignore?",
      true
    );
    const updateAgents = await askYesNo(
      rl,
      "Add Rebase instructions to AGENTS.md?",
      true
    );
    const updateRebaseIgnore = await askYesNo(
      rl,
      "Create .rebaseignore privacy filter?",
      true
    );
    return { updateGitignore, updateAgents, updateRebaseIgnore };
  } finally {
    rl.close();
  }
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
