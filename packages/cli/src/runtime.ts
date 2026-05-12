import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { RocketRideClient } from "rocketride";
import { findGitRoot } from "@tempo/coordinator";

const DEFAULT_COORDINATOR_PORT = 3747;
const DEFAULT_DASHBOARD_PORT = 3748;
const DEFAULT_ROCKETRIDE_URI = "http://127.0.0.1:5565";
const TEMPO_AGENTS_BLOCK = [
  "<!-- BEGIN TEMPO -->",
  "## Tempo coordination",
  "",
  "This repo uses Tempo to coordinate parallel AI coding sessions.",
  "",
  "When working in this repo, Codex must:",
  "",
  "- rely on Tempo hooks for automatic session/activity evidence",
  "- call `tempo_join` only if hooks are unavailable or Tempo does not recognize the session",
  "- call `tempo_plan` before meaningful edits when the plan matters for coordination",
  "- call `tempo_checkpoint` after meaningful edit batches",
  "- call `tempo_checkpoint` before committing",
  "- report Tempo notifications to the user",
  "- treat Tempo `workOrders` as the delegated task source of truth for this session",
  "- pause only on blocking Tempo risk until the user gives direction",
  "- if `tempo_wait_for_direction` times out with `keepWaiting: true`, call it again instead of ending the session cold",
  "- When Tempo returns `choices`, show the numbered options and keep polling with `tempo_wait_for_direction` until the user records a choice or another session sends a direction",
  "- If another session records the decision, receive the resulting `directions` or `workOrders`, acknowledge them, and continue automatically from that Tempo plan",
  "- if `tempo_wait_for_direction` returns `workOrders`, acknowledge the assigned role in the chat and follow that work order before continuing",
  "- when Tempo returns `directions`, present the role and plan to the user, call `tempo_acknowledge_intervention`, then continue from that direction",
  "- if the user chooses split ownership in this chat, call `tempo_record_decision`; this session becomes the owner unless the user names a different owner",
  "- if Tempo MCP tools return `unsupported call`, use the token-auth shell fallback, for example `tempo mcp checkpoint --json '{\"sessionId\":\"...\"}'` or `tempo mcp wait-for-direction --json '{\"sessionId\":\"...\",\"timeoutMs\":3000}'`",
  "- do not add external context providers without an ADR and explicit Krish approval",
  "",
  "<!-- END TEMPO -->",
  ""
].join("\n");

export interface RuntimePrompts {
  updateGitignore: boolean;
  updateAgents: boolean;
  updateTempoIgnore?: boolean;
}

export interface PrepareRuntimeInput {
  cwd: string;
  prompts: RuntimePrompts;
  coordinatorPort?: number;
  dashboardPort?: number;
}

export interface TempoRuntime {
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
  rocketRideUri: string;
}

export async function prepareRuntime(
  input: PrepareRuntimeInput
): Promise<TempoRuntime> {
  const repoRoot = await findGitRoot(input.cwd);
  const dataDir = path.join(repoRoot, ".tempo");
  await mkdir(dataDir, { recursive: true });
  await ensureTempoDataGitignore(dataDir);
  const hookPath = path.join(dataDir, "hooks", "codex-hook.mjs");

  const coordinatorPort = input.coordinatorPort ?? DEFAULT_COORDINATOR_PORT;
  const dashboardPort = input.dashboardPort ?? DEFAULT_DASHBOARD_PORT;
  const runtimePath = path.join(dataDir, "runtime.json");
  const existing = await readRuntime(runtimePath);
  const runtime: TempoRuntime = {
    repoRoot,
    dataDir,
    dbPath: path.join(dataDir, "tempo.sqlite"),
    envPath: path.join(dataDir, ".env"),
    hookPath,
    token: existing?.token ?? nanoid(32),
    coordinatorPort,
    dashboardPort,
    coordinatorUrl: `http://127.0.0.1:${coordinatorPort}`,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    mcpUrl: `http://127.0.0.1:${coordinatorPort}/mcp`,
    rocketRideUri:
      existing?.rocketRideUri ??
      process.env.ROCKETRIDE_URI ??
      DEFAULT_ROCKETRIDE_URI
  };

  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
  await ensureCodexHookScript(hookPath);

  if (input.prompts.updateGitignore) {
    await ensureLine(path.join(repoRoot, ".gitignore"), ".tempo/");
  }
  if (input.prompts.updateAgents) {
    await ensureTempoAgentsBlock(path.join(repoRoot, "AGENTS.md"));
  }
  if (input.prompts.updateTempoIgnore) {
    await ensureLine(path.join(repoRoot, ".tempoignore"), "# Tempo privacy ignore");
  }

  return runtime;
}

export async function readRuntimeState(cwd: string): Promise<TempoRuntime | null> {
  const checkoutRoot = await findGitRoot(cwd);
  const lookup = await findRuntimeLookup(checkoutRoot);
  const existing = lookup.existing;
  if (!existing?.token) return null;
  const coordinatorPort = existing.coordinatorPort ?? DEFAULT_COORDINATOR_PORT;
  const dashboardPort = existing.dashboardPort ?? DEFAULT_DASHBOARD_PORT;
  const dataDir = existing.dataDir ?? lookup.dataDir;
  return {
    repoRoot: existing.repoRoot ?? lookup.repoRoot,
    dataDir,
    dbPath: existing.dbPath ?? path.join(dataDir, "tempo.sqlite"),
    envPath: existing.envPath ?? path.join(dataDir, ".env"),
    hookPath: existing.hookPath ?? path.join(dataDir, "hooks", "codex-hook.mjs"),
    token: existing.token,
    coordinatorPort,
    dashboardPort,
    coordinatorUrl:
      existing.coordinatorUrl ?? `http://127.0.0.1:${coordinatorPort}`,
    dashboardUrl: existing.dashboardUrl ?? `http://127.0.0.1:${dashboardPort}`,
    mcpUrl: existing.mcpUrl ?? `http://127.0.0.1:${coordinatorPort}/mcp`,
    rocketRideUri:
      existing.rocketRideUri ??
      process.env.ROCKETRIDE_URI ??
      DEFAULT_ROCKETRIDE_URI
  };
}

async function findRuntimeLookup(repoRoot: string): Promise<{
  repoRoot: string;
  dataDir: string;
  existing: Partial<TempoRuntime> | null;
}> {
  const primary = await readRuntimeAt(repoRoot);
  if (primary.existing?.token) return primary;

  const mainWorktreeRoot = await findMainWorktreeRoot(repoRoot);
  if (mainWorktreeRoot && mainWorktreeRoot !== repoRoot) {
    const shared = await readRuntimeAt(mainWorktreeRoot);
    if (shared.existing?.token) return shared;
  }

  return primary;
}

async function readRuntimeAt(repoRoot: string): Promise<{
  repoRoot: string;
  dataDir: string;
  existing: Partial<TempoRuntime> | null;
}> {
  const dataDir = path.join(repoRoot, ".tempo");
  return {
    repoRoot,
    dataDir,
    existing: await readRuntime(path.join(dataDir, "runtime.json"))
  };
}

async function findMainWorktreeRoot(repoRoot: string): Promise<string | null> {
  const gitFile = (await readOptional(path.join(repoRoot, ".git"))).trim();
  const gitDirLine = gitFile.split(/\r?\n/, 1)[0] ?? "";
  const match = /^gitdir:\s*(.+)$/i.exec(gitDirLine);
  if (!match) return null;

  const gitDir = path.resolve(repoRoot, match[1] ?? "");
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = gitDir.lastIndexOf(marker);
  if (markerIndex === -1) return null;

  const commonGitDir = gitDir.slice(0, markerIndex + `${path.sep}.git`.length);
  return path.dirname(commonGitDir);
}

export interface RocketRideRuntimeCheckInput {
  rocketRideUri?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
  clientFactory?: RocketRideClientFactory | undefined;
}

export interface RocketRideRuntimeCheck {
  ok: boolean;
  uri: string;
  message: string;
  status?: number | undefined;
}

type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Pick<Response, "ok" | "status" | "statusText">>;
type RocketRideClientLike = {
  connect(options?: { uri?: string; auth?: string; timeout?: number }): Promise<void>;
  ping(token?: string): Promise<void>;
  disconnect(): Promise<void>;
};
type RocketRideClientFactory = (
  uri: string,
  apiKey: string
) => RocketRideClientLike;

export async function checkRocketRideRuntime(
  input: RocketRideRuntimeCheckInput = {}
): Promise<RocketRideRuntimeCheck> {
  const uri = normalizeRocketRideUri(
    input.rocketRideUri ?? process.env.ROCKETRIDE_URI ?? DEFAULT_ROCKETRIDE_URI
  );
  const apiKey = input.apiKey ?? process.env.ROCKETRIDE_APIKEY;
  const timeoutMs = input.timeoutMs ?? 3_000;
  let sdkCheck: RocketRideRuntimeCheck | null = null;
  if (apiKey) {
    sdkCheck = await withTimeout(
      checkRocketRideWithSdk({
        uri,
        apiKey,
        clientFactory: input.clientFactory
      }),
      timeoutMs,
      {
        ok: false,
        uri,
        message: `RocketRide SDK ping timed out at ${uri}. Start RocketRide locally or set ROCKETRIDE_URI.`
      }
    );
    if (sdkCheck.ok) return sdkCheck;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await withTimeout(
      fetchImpl(`${uri}/health`, { method: "GET" }),
      timeoutMs,
      null
    );
    if (!response) {
      if (sdkCheck) return sdkCheck;
      return {
        ok: false,
        uri,
        message: `RocketRide preflight timed out at ${uri}/health. Start RocketRide locally or set ROCKETRIDE_URI.`
      };
    }
    if (response.ok) {
      return {
        ok: true,
        uri,
        message: `RocketRide is online at ${uri}.`,
        status: response.status
      };
    }
    return {
      ok: false,
      uri,
      message: `RocketRide preflight failed at ${uri}/health (${response.status} ${response.statusText}).`,
      status: response.status
    };
  } catch (_error) {
    if (sdkCheck) return sdkCheck;
    return {
      ok: false,
      uri,
      message: `RocketRide is offline at ${uri}. Start RocketRide locally or set ROCKETRIDE_URI.`
    };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(timeoutValue), timeoutMs);
    })
  ]);
}

async function checkRocketRideWithSdk(input: {
  uri: string;
  apiKey: string;
  clientFactory?: RocketRideClientFactory | undefined;
}): Promise<RocketRideRuntimeCheck> {
  const client =
    input.clientFactory?.(input.uri, input.apiKey) ??
    new RocketRideClient({
      uri: input.uri,
      auth: input.apiKey,
      requestTimeout: 1500,
      module: "tempo-cli"
    });
  try {
    await client.connect({
      uri: input.uri,
      auth: input.apiKey,
      timeout: 1500
    });
    await client.ping();
    return {
      ok: true,
      uri: input.uri,
      message: `RocketRide SDK ping succeeded at ${input.uri}.`
    };
  } catch (error) {
    return {
      ok: false,
      uri: input.uri,
      message: `RocketRide SDK ping failed at ${input.uri}: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function normalizeRocketRideUri(uri: string): string {
  return uri.replace(/\/+$/, "") || DEFAULT_ROCKETRIDE_URI;
}

async function readRuntime(runtimePath: string): Promise<Partial<TempoRuntime> | null> {
  try {
    return JSON.parse(await readFile(runtimePath, "utf8")) as Partial<TempoRuntime>;
  } catch (_error) {
    return null;
  }
}

export async function loadTempoEnv(
  envPath: string,
  target: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Promise<void> {
  const current = await readOptional(envPath);
  if (!current) return;
  const parsed = parseTempoEnv(current);
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

export function parseTempoEnv(source: string): Record<string, string> {
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

async function ensureTempoDataGitignore(dataDir: string): Promise<void> {
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

async function ensureTempoAgentsBlock(filePath: string): Promise<void> {
  const current = await readOptional(filePath);
  const begin = "<!-- BEGIN TEMPO -->";
  const end = "<!-- END TEMPO -->";
  const beginIndex = current.indexOf(begin);
  const endIndex = current.indexOf(end);
  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    const before = current.slice(0, beginIndex).trimEnd();
    const after = current.slice(endIndex + end.length).trimStart();
    const next = [before, TEMPO_AGENTS_BLOCK.trimEnd(), after]
      .filter(Boolean)
      .join("\n\n");
    await writeFile(filePath, `${next}\n`);
    return;
  }
  const separator = current.trim().length > 0 ? "\n\n" : "";
  await writeFile(filePath, `${current.trimEnd()}${separator}${TEMPO_AGENTS_BLOCK}`);
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}
