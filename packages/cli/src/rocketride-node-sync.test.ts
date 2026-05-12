import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { syncTempoRocketRideNode } from "./rocketride-node-sync.js";

describe("syncTempoRocketRideNode", () => {
  it("copies the vendored Tempo RocketRide node into a local RocketRide server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tempo-node-sync-"));
    const sourceDir = path.join(root, "rocketride", "nodes", "tempo_coordination");
    const serverDir = path.join(root, "rocketride-server");
    const runtimeNodesDir = path.join(serverDir, "dist", "server", "nodes");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(runtimeNodesDir, { recursive: true });
    await writeFile(path.join(sourceDir, "logic.py"), "VALUE = 'tempo'\n");
    await writeFile(path.join(sourceDir, "services.json"), "{\"name\":\"tempo\"}\n");

    const result = await syncTempoRocketRideNode({
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
          "tempo_coordination",
          "logic.py"
        ),
        "utf8"
      )
    ).resolves.toBe("VALUE = 'tempo'\n");
    await expect(
      readFile(
        path.join(runtimeNodesDir, "tempo_coordination", "logic.py"),
        "utf8"
      )
    ).resolves.toBe("VALUE = 'tempo'\n");
    expect(result.targetDir).toBe(
      path.join(serverDir, "nodes", "src", "nodes", "tempo_coordination")
    );
    expect(result.runtimeTargetDir).toBe(
      path.join(runtimeNodesDir, "tempo_coordination")
    );
    expect(result.filesCopied).toEqual(["logic.py", "services.json"]);
  });

  it("fails with setup guidance when no RocketRide server directory is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tempo-node-sync-"));
    const sourceDir = path.join(root, "rocketride", "nodes", "tempo_coordination");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "logic.py"), "VALUE = 'tempo'\n");

    await expect(syncTempoRocketRideNode({ sourceDir })).rejects.toThrow(
      "Set ROCKETRIDE_SERVER_DIR or pass --rocketride-server-dir"
    );
  });
});
