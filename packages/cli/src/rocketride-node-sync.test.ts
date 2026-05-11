import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { syncRebaseRocketRideNode } from "./rocketride-node-sync.js";

describe("syncRebaseRocketRideNode", () => {
  it("copies the vendored Rebase RocketRide node into a local RocketRide server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rebase-node-sync-"));
    const sourceDir = path.join(root, "rocketride", "nodes", "rebase_coordination");
    const serverDir = path.join(root, "rocketride-server");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "logic.py"), "VALUE = 'rebase'\n");
    await writeFile(path.join(sourceDir, "services.json"), "{\"name\":\"rebase\"}\n");

    const result = await syncRebaseRocketRideNode({
      sourceDir,
      rocketRideServerDir: serverDir
    });

    await expect(
      readFile(
        path.join(
          serverDir,
          "nodes",
          "src",
          "nodes",
          "rebase_coordination",
          "logic.py"
        ),
        "utf8"
      )
    ).resolves.toBe("VALUE = 'rebase'\n");
    expect(result.targetDir).toBe(
      path.join(serverDir, "nodes", "src", "nodes", "rebase_coordination")
    );
    expect(result.filesCopied).toEqual(["logic.py", "services.json"]);
  });

  it("fails with setup guidance when no RocketRide server directory is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rebase-node-sync-"));
    const sourceDir = path.join(root, "rocketride", "nodes", "rebase_coordination");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "logic.py"), "VALUE = 'rebase'\n");

    await expect(syncRebaseRocketRideNode({ sourceDir })).rejects.toThrow(
      "Set ROCKETRIDE_SERVER_DIR or pass --rocketride-server-dir"
    );
  });
});
