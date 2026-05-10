import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { findGitRoot } from "@rebase/coordinator";

const DEFAULT_COORDINATOR_PORT = 3747;
const DEFAULT_DASHBOARD_PORT = 3748;
const REBASE_AGENTS_BLOCK = [
  "<!-- BEGIN REBASE -->",
  "## Rebase coordination",
  "",
  "This repo uses Rebase to coordinate parallel AI coding sessions.",
  "",
  "When working in this repo, Codex must:",
  "",
  "- rely on Rebase hooks for automatic session/activity evidence",
  "- call `rebase_join` only if hooks are unavailable or Rebase does not recognize the session",
  "- call `rebase_plan` before meaningful edits when the plan matters for coordination",
  "- call `rebase_checkpoint` after meaningful edit batches",
  "- call `rebase_checkpoint` before committing",
  "- report Rebase notifications to the user",
  "- pause only on blocking Rebase risk until the user gives direction",
  "- if `rebase_wait_for_direction` times out with `keepWaiting: true`, call it again instead of ending the session cold",
  "- when Rebase returns `directions`, present the role and plan to the user, call `rebase_acknowledge_intervention`, then continue from that direction",
  "- if the user chooses split ownership in this chat, call `rebase_record_decision`; this session becomes the owner unless the user names a different owner",
  "- do not add external context providers without an ADR and explicit Krish approval",
  "",
  "<!-- END REBASE -->",
  ""
].join("\n");

export interface RuntimePrompts {
  updateGitignore: boolean;
  updateAgents: boolean;
  updateRebaseIgnore?: boolean;
}

export interface PrepareRuntimeInput {
  cwd: string;
  prompts: RuntimePrompts;
  coordinatorPort?: number;
  dashboardPort?: number;
}

export interface RebaseRuntime {
  repoRoot: string;
  dataDir: string;
  dbPath: string;
  envPath: string;
  hookPath: string;
  token: string;
  coordinatorPort: number;
  dashboardPort: number;
  coordinatorUrl: string;
  dashboardUrl: string;
  mcpUrl: string;
}

export async function prepareRuntime(
  input: PrepareRuntimeInput
): Promise<RebaseRuntime> {
  const repoRoot = await findGitRoot(input.cwd);
  const dataDir = path.join(repoRoot, ".rebase");
  await mkdir(dataDir, { recursive: true });
  await ensureRebaseDataGitignore(dataDir);
  const hookPath = path.join(dataDir, "hooks", "codex-hook.mjs");

  const coordinatorPort = input.coordinatorPort ?? DEFAULT_COORDINATOR_PORT;
  const dashboardPort = input.dashboardPort ?? DEFAULT_DASHBOARD_PORT;
  const runtimePath = path.join(dataDir, "runtime.json");
  const existing = await readRuntime(runtimePath);
  const runtime: RebaseRuntime = {
    repoRoot,
    dataDir,
    dbPath: path.join(dataDir, "rebase.sqlite"),
    envPath: path.join(dataDir, ".env"),
    hookPath,
    token: existing?.token ?? nanoid(32),
    coordinatorPort,
    dashboardPort,
    coordinatorUrl: `http://127.0.0.1:${coordinatorPort}`,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    mcpUrl: `http://127.0.0.1:${coordinatorPort}/mcp`
  };

  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
  await ensureCodexHookScript(hookPath);

  if (input.prompts.updateGitignore) {
    await ensureLine(path.join(repoRoot, ".gitignore"), ".rebase/");
  }
  if (input.prompts.updateAgents) {
    await ensureRebaseAgentsBlock(path.join(repoRoot, "AGENTS.md"));
  }
  if (input.prompts.updateRebaseIgnore) {
    await ensureLine(path.join(repoRoot, ".rebaseignore"), "# Rebase privacy ignore");
  }

  return runtime;
}

export async function readRuntimeState(cwd: string): Promise<RebaseRuntime | null> {
  const repoRoot = await findGitRoot(cwd);
  const dataDir = path.join(repoRoot, ".rebase");
  const runtimePath = path.join(dataDir, "runtime.json");
  const existing = await readRuntime(runtimePath);
  if (!existing?.token) return null;
  const coordinatorPort = existing.coordinatorPort ?? DEFAULT_COORDINATOR_PORT;
  const dashboardPort = existing.dashboardPort ?? DEFAULT_DASHBOARD_PORT;
  return {
    repoRoot,
    dataDir,
    dbPath: existing.dbPath ?? path.join(dataDir, "rebase.sqlite"),
    envPath: existing.envPath ?? path.join(dataDir, ".env"),
    hookPath: existing.hookPath ?? path.join(dataDir, "hooks", "codex-hook.mjs"),
    token: existing.token,
    coordinatorPort,
    dashboardPort,
    coordinatorUrl:
      existing.coordinatorUrl ?? `http://127.0.0.1:${coordinatorPort}`,
    dashboardUrl: existing.dashboardUrl ?? `http://127.0.0.1:${dashboardPort}`,
    mcpUrl: existing.mcpUrl ?? `http://127.0.0.1:${coordinatorPort}/mcp`
  };
}

async function readRuntime(runtimePath: string): Promise<Partial<RebaseRuntime> | null> {
  try {
    return JSON.parse(await readFile(runtimePath, "utf8")) as Partial<RebaseRuntime>;
  } catch (_error) {
    return null;
  }
}

export async function loadRebaseEnv(
  envPath: string,
  target: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Promise<void> {
  const current = await readOptional(envPath);
  if (!current) return;
  const parsed = parseRebaseEnv(current);
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

export function parseRebaseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
  }
  return values;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "");
}

async function ensureRebaseDataGitignore(dataDir: string): Promise<void> {
  const filePath = path.join(dataDir, ".gitignore");
  const current = await readOptional(filePath);
  if (current.trim()) return;
  await writeFile(filePath, "*\n!.gitignore\n");
}

async function ensureCodexHookScript(hookPath: string): Promise<void> {
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(
    hookPath,
    [
      "#!/usr/bin/env node",
      "import { readFile } from 'node:fs/promises';",
      "",
      "const runtimeUrl = new URL('../runtime.json', import.meta.url);",
      "const runtime = JSON.parse(await readFile(runtimeUrl, 'utf8'));",
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "const raw = Buffer.concat(chunks).toString('utf8').trim();",
      "const body = raw ? JSON.parse(raw) : {};",
      "await fetch(`${runtime.coordinatorUrl}/api/hooks/codex`, {",
      "  method: 'POST',",
      "  headers: {",
      "    'content-type': 'application/json',",
      "    authorization: `Bearer ${runtime.token}`",
      "  },",
      "  body: JSON.stringify({ agentKind: 'codex', ...body })",
      "});",
      ""
    ].join("\n")
  );
  await chmod(hookPath, 0o755);
}

async function ensureLine(filePath: string, line: string): Promise<void> {
  const current = await readOptional(filePath);
  const lines = current.split(/\r?\n/).filter(Boolean);
  if (lines.includes(line)) return;
  const next = [...lines, line].join("\n");
  await writeFile(filePath, `${next}\n`);
}

async function ensureRebaseAgentsBlock(filePath: string): Promise<void> {
  const current = await readOptional(filePath);
  if (current.includes("BEGIN REBASE")) return;
  const separator = current.trim().length > 0 ? "\n\n" : "";
  await writeFile(filePath, `${current.trimEnd()}${separator}${REBASE_AGENTS_BLOCK}`);
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}
