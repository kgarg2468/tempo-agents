import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_TEMPO_PIPELINES } from "@tempo/coordinator";
import { createRocketRideRunner } from "./rocketride-runner.js";

async function createPipelineDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "tempo-pipelines-"));
  for (const pipeline of REQUIRED_TEMPO_PIPELINES) {
    await writeFile(
      path.join(dir, `${pipeline}.pipe`),
      `${JSON.stringify(executablePipeline(pipeline))}\n`
    );
  }
  return dir;
}

describe("createRocketRideRunner", () => {
  it("validates that every required pipeline can be started and returns typed smoke output", async () => {
    const calls: string[] = [];
    const sentMimeTypes: Array<string | undefined> = [];
    const pipelineDir = await createPipelineDir();
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      clientFactory: () => ({
        async connect() {
          calls.push("connect");
        },
        async disconnect() {
          calls.push("disconnect");
        },
        async validate() {
          calls.push("validate");
          return {};
        },
        async use(options) {
          calls.push(`use:${path.basename(options?.filepath ?? "")}`);
          return { token: `token-${calls.length}` };
        },
        async terminate(token) {
          calls.push(`terminate:${token}`);
        },
        async send(_token, data, _objinfo, mimetype) {
          calls.push("send");
          sentMimeTypes.push(mimetype);
          return typedOutputForRequest(JSON.parse(String(data)) as Record<string, unknown>);
        }
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: true,
      pipelineStatus: "validated"
    });

    expect(calls.filter((call) => call === "validate")).toHaveLength(
      REQUIRED_TEMPO_PIPELINES.length
    );
    expect(calls.filter((call) => call.startsWith("use:"))).toHaveLength(
      REQUIRED_TEMPO_PIPELINES.length
    );
    expect(calls.filter((call) => call.startsWith("terminate:"))).toHaveLength(
      REQUIRED_TEMPO_PIPELINES.length
    );
    expect(calls.filter((call) => call === "send")).toHaveLength(
      REQUIRED_TEMPO_PIPELINES.length
    );
    expect(sentMimeTypes).toEqual(
      REQUIRED_TEMPO_PIPELINES.map(() => "text/plain")
    );
  });

  it("fails validation when RocketRide returns only pipeline metadata", async () => {
    const pipelineDir = await createPipelineDir();
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          return {};
        },
        async use() {
          return { token: "rr-token" };
        },
        async terminate() {},
        async send() {
          return {
            name: "tempo-fingerprint.smoke.json",
            path: "",
            objectId: "metadata-only"
          };
        }
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: false,
      pipelineStatus: "failed",
      lastError: expect.stringContaining(
        "tempo-fingerprint: RocketRide tempo-fingerprint output did not match"
      )
    });
  });

  it("fails validation before start when a required pipeline has no source component", async () => {
    const pipelineDir = await mkdtemp(path.join(tmpdir(), "tempo-pipelines-"));
    for (const pipeline of REQUIRED_TEMPO_PIPELINES) {
      await writeFile(
        path.join(pipelineDir, `${pipeline}.pipe`),
        `${JSON.stringify({ name: pipeline, components: [] })}\n`
      );
    }
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          return {};
        },
        async use() {
          throw new Error("should not start invalid pipeline");
        },
        async terminate() {},
        async send() {
          return {};
        }
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: false,
      pipelineStatus: "failed",
      lastError: expect.stringContaining(
        "tempo-fingerprint.pipe is missing a source component"
      )
    });
  });

  it("fails validation when a required pipeline cannot start", async () => {
    const pipelineDir = await createPipelineDir();
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          return {};
        },
        async use() {
          throw new Error("Pipeline does not have a source component defined");
        },
        async terminate() {},
        async send() {
          return {};
        }
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: false,
      pipelineStatus: "failed",
      lastError: expect.stringContaining(
        "tempo-fingerprint: Pipeline does not have a source component defined"
      )
    });
  });

  it("adds sync guidance when RocketRide cannot load the Tempo node", async () => {
    const pipelineDir = await createPipelineDir();
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          throw new Error("Unknown provider tempo_coordination");
        },
        async use() {
          return { token: "rr-token" };
        },
        async terminate() {},
        async send() {
          return {};
        }
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: false,
      pipelineStatus: "failed",
      lastError: expect.stringContaining("pnpm tempo rocketride:sync")
    });
  });

  it("preflights the checked-in Tempo pipeline files", async () => {
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          return {};
        },
        async use() {
          return { token: "rr-token" };
        },
        async send(_token, data) {
          return typedOutputForRequest(JSON.parse(String(data)) as Record<string, unknown>);
        },
        async terminate() {}
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: true,
      pipelineStatus: "validated",
      authoritative: true
    });
  });

  it("does not hang startup validation when RocketRide disconnect never settles", async () => {
    const pipelineDir = await createPipelineDir();
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      disconnectTimeoutMs: 5,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {
          await new Promise(() => undefined);
        },
        async validate() {
          return {};
        },
        async use() {
          return { token: "rr-token" };
        },
        async send(_token, data) {
          return typedOutputForRequest(JSON.parse(String(data)) as Record<string, unknown>);
        },
        async terminate() {}
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: true,
      pipelineStatus: "validated"
    });
  });

  it("fails closed instead of hanging when RocketRide send never returns", async () => {
    const pipelineDir = await createPipelineDir();
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      operationTimeoutMs: 5,
      disconnectTimeoutMs: 5,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          return {};
        },
        async use() {
          return { token: "rr-token" };
        },
        async send() {
          await new Promise(() => undefined);
        },
        async terminate() {}
      })
    });

    await expect(runner.validateRequiredPipelines?.()).resolves.toMatchObject({
      ok: false,
      pipelineStatus: "failed",
      lastError: expect.stringContaining(
        "tempo-fingerprint: tempo-fingerprint send timed out"
      )
    });
  });

  it("runs a pipeline and returns the RocketRide task token as the run id", async () => {
    const pipelineDir = await createPipelineDir();
    const sent: unknown[] = [];
    const runner = createRocketRideRunner({
      uri: "http://127.0.0.1:5565",
      pipelineDir,
      clientFactory: () => ({
        async connect() {},
        async disconnect() {},
        async validate() {
          return {};
        },
        async use() {
          return { token: "rr-token" };
        },
        async send(_token, data) {
          sent.push(JSON.parse(String(data)));
          return { ok: true };
        },
        async terminate() {}
      })
    });

    await expect(
      runner.runPipeline("tempo-fingerprint", { worktreeId: "wt-a" })
    ).resolves.toEqual({
      runId: "rr-token",
      output: { ok: true }
    });
    expect(sent).toEqual([{ worktreeId: "wt-a" }]);
  });
});

function executablePipeline(name: string) {
  return {
    name,
    source: "source_1",
    components: [
      {
        id: "source_1",
        provider: "webhook",
        config: {
          key: "webhook://*",
          mode: "Source",
          name: "Tempo Input",
          include: [{ path: "*" }],
          parameters: {
            endpoint: "/pipe/process",
            port: 5565
          },
          sync: false,
          type: "webhook"
        },
        ui: {}
      },
      {
        id: "tempo_1",
        provider: "tempo_coordination",
        config: {
          operation: operationForPipeline(name)
        },
        input: [
          {
            lane: "text",
            from: "source_1"
          }
        ]
      },
      {
        id: "response_1",
        provider: "response",
        config: {},
        ui: {},
        input: [
          {
            lane: "text",
            from: "tempo_1"
          }
        ]
      }
    ]
  };
}

function operationForPipeline(name: string): string {
  return name.replace(/^tempo-/, "");
}

function typedOutputForRequest(request: Record<string, unknown>) {
  switch (request.operation) {
    case "fingerprint":
      return {
        response: JSON.stringify({
          fingerprint: {
            id: "smoke-fingerprint",
            repoId: request.repoId,
            worktreeId: request.worktreeId,
            diffHash: request.diffHash,
            createdAt: 1778000000000,
            filesTouched: ["src/shared/task.ts"],
            symbols: {
              added: [],
              modified: ["Task"],
              removed: []
            },
            surfaces: [
              {
                id: "task-type",
                label: "Task type",
                kind: "type",
                files: ["src/shared/task.ts"],
                confidence: 0.9,
                evidence: ["RocketRide smoke validation"]
              }
            ],
            semanticSummary: "RocketRide smoke fingerprint",
            contractChanges: ["Task type"],
            confidence: 0.9,
            source: "heuristic"
          }
        })
      };
    case "collision":
      return { response: JSON.stringify({ conflicts: [], episodes: [] }) };
    case "work-order":
      return { response: JSON.stringify({ episodes: [], workOrders: [] }) };
    case "merge-risk":
      return {
        response: JSON.stringify({
          mergeRisk: {
            id: "smoke-merge-risk",
            repoId: "smoke-repo",
            episodeId: "smoke-episode",
            status: "blocked",
            risk: "high",
            safe: false,
            diffHash: "smoke-diff-a+smoke-diff-b",
            predictedConflicts: [
              {
                id: "smoke-predicted-conflict",
                risk: "high",
                reasonCode: "same_hunk",
                summary: "Two worktrees edit the same Task hunk.",
                files: ["src/shared/task.ts"],
                symbols: ["Task"],
                affectedWorktreeIds: ["smoke-worktree-a", "smoke-worktree-b"],
                evidence: ["Overlapping hunks in src/shared/task.ts"],
                blocking: true
              }
            ],
            warnings: [],
            requiredWorkOrders: [],
            evidence: [
              {
                label: "Shared hunk",
                detail: "Both smoke worktrees edit src/shared/task.ts.",
                files: ["src/shared/task.ts"],
                worktreeIds: ["smoke-worktree-a", "smoke-worktree-b"]
              }
            ],
            createdAt: 1778000000000
          }
        })
      };
    default:
      throw new Error(`Unexpected smoke operation ${String(request.operation)}`);
  }
}
