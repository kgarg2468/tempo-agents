import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SyncTempoRocketRideNodeInput {
  sourceDir?: string | undefined;
  rocketRideServerDir?: string | undefined;
}

export interface SyncTempoRocketRideNodeResult {
  sourceDir: string;
  targetDir: string;
  runtimeTargetDir?: string | undefined;
  filesCopied: string[];
}

const NODE_NAME = "tempo_coordination";

export async function syncTempoRocketRideNode(
  input: SyncTempoRocketRideNodeInput = {}
): Promise<SyncTempoRocketRideNodeResult> {
  const sourceDir = input.sourceDir ?? defaultTempoRocketRideNodeDir();
  const rocketRideServerDir =
    input.rocketRideServerDir ?? process.env.ROCKETRIDE_SERVER_DIR;
  if (!rocketRideServerDir) {
    throw new Error(
      "Set ROCKETRIDE_SERVER_DIR or pass --rocketride-server-dir=/path/to/rocketride-server before running `pnpm tempo rocketride:sync`."
    );
  }

  await assertDirectory(sourceDir, "Tempo RocketRide node source");
  const filesCopied = await listTopLevelFiles(sourceDir);
  const targetDir = path.join(
    rocketRideServerDir,
    "nodes",
    "src",
    "nodes",
    NODE_NAME
  );
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { force: true, recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });

  const runtimeTargetDir = await syncRuntimeNodeIfPresent(
    sourceDir,
    rocketRideServerDir
  );

  return { sourceDir, targetDir, runtimeTargetDir, filesCopied };
}

export function defaultTempoRocketRideNodeDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../rocketride/nodes/tempo_coordination"
  );
}

async function assertDirectory(dir: string, label: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (info.isDirectory()) return;
  } catch (_error) {
    // Handled below.
  }
  throw new Error(`${label} not found at ${dir}.`);
}

async function listTopLevelFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function syncRuntimeNodeIfPresent(
  sourceDir: string,
  rocketRideServerDir: string
): Promise<string | undefined> {
  const runtimeNodesDir = path.join(rocketRideServerDir, "dist", "server", "nodes");
  try {
    const info = await stat(runtimeNodesDir);
    if (!info.isDirectory()) return undefined;
  } catch (_error) {
    return undefined;
  }

  const targetDir = path.join(runtimeNodesDir, NODE_NAME);
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { force: true, recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
  return targetDir;
}
