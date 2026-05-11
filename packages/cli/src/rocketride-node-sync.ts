import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SyncRebaseRocketRideNodeInput {
  sourceDir?: string | undefined;
  rocketRideServerDir?: string | undefined;
}

export interface SyncRebaseRocketRideNodeResult {
  sourceDir: string;
  targetDir: string;
  filesCopied: string[];
}

const NODE_NAME = "rebase_coordination";

export async function syncRebaseRocketRideNode(
  input: SyncRebaseRocketRideNodeInput = {}
): Promise<SyncRebaseRocketRideNodeResult> {
  const sourceDir = input.sourceDir ?? defaultRebaseRocketRideNodeDir();
  const rocketRideServerDir =
    input.rocketRideServerDir ?? process.env.ROCKETRIDE_SERVER_DIR;
  if (!rocketRideServerDir) {
    throw new Error(
      "Set ROCKETRIDE_SERVER_DIR or pass --rocketride-server-dir=/path/to/rocketride-server before running `pnpm rebase rocketride:sync`."
    );
  }

  await assertDirectory(sourceDir, "Rebase RocketRide node source");
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

  return { sourceDir, targetDir, filesCopied };
}

export function defaultRebaseRocketRideNodeDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../rocketride/nodes/rebase_coordination"
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
