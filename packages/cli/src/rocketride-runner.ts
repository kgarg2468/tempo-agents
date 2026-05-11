import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RocketRideClient } from "rocketride";
import type {
  RebasePipelineName,
  RocketRideCoordinator,
  RocketRidePipelineRun,
  RocketRideStatus
} from "@rebase/coordinator";
import {
  parsePipelineRunOutput,
  REQUIRED_REBASE_PIPELINES,
  smokeInputForPipeline
} from "@rebase/coordinator";

export interface CreateRocketRideRunnerInput {
  uri: string;
  apiKey?: string | undefined;
  pipelineDir?: string | undefined;
  clientFactory?: RocketRideClientFactory | undefined;
}

export function createRocketRideRunner(
  input: CreateRocketRideRunnerInput
): RocketRideCoordinator {
  return new CliRocketRideRunner(input);
}

class CliRocketRideRunner implements RocketRideCoordinator {
  private lastStatus: RocketRideStatus;

  constructor(private readonly input: CreateRocketRideRunnerInput) {
    this.lastStatus = {
      mode: "required",
      ok: true,
      uri: input.uri,
      pipelineStatus: "unknown",
      authoritative: false,
      message: "RocketRide configured."
    };
  }

  status(): RocketRideStatus {
    return this.lastStatus;
  }

  async validateRequiredPipelines(): Promise<RocketRideStatus> {
    try {
      await withRocketRideClient(this.input, async (client) => {
        for (const pipeline of REQUIRED_REBASE_PIPELINES) {
          const pipelinePath = this.pipelinePath(pipeline);
          const config = await readPipelineConfig(pipelinePath);
          const pipelineConfig = unwrapPipelineConfig(config);
          assertExecutablePipeline(pipelinePath, pipelineConfig);
          try {
            await client.validate({ pipeline: pipelineConfig });
            const { token } = await client.use({
              filepath: pipelinePath,
              ttl: 60,
              pipelineTraceLevel: "summary"
            });
            try {
              const output = await client.send(
                token,
                JSON.stringify(smokeInputForPipeline(pipeline)),
                { name: `${pipeline}.smoke.json` },
                "text/plain"
              );
              parsePipelineRunOutput(pipeline, output);
            } finally {
              await client.terminate(token).catch(() => undefined);
            }
          } catch (error) {
            throw new Error(`${pipeline}: ${errorMessage(error)}`);
          }
        }
      });
      this.lastStatus = {
        mode: "required",
        ok: true,
        uri: this.input.uri,
        pipelineStatus: "validated",
        authoritative: true,
        message: "RocketRide pipelines validated."
      };
    } catch (error) {
      this.lastStatus = {
        mode: "required",
        ok: false,
        uri: this.input.uri,
        pipelineStatus: "failed",
        authoritative: false,
        message: "RocketRide pipeline validation failed.",
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
    return this.lastStatus;
  }

  async runPipeline(
    name: RebasePipelineName,
    input: Record<string, unknown>
  ): Promise<RocketRidePipelineRun> {
    return withRocketRideClient(this.input, async (client) => {
      const { token } = await client.use({
        filepath: this.pipelinePath(name),
        ttl: 300,
        pipelineTraceLevel: "summary"
      });
      try {
        const output = await client.send(
          token,
          JSON.stringify(input),
          { name: `${name}.input.json` },
          "text/plain"
        );
        return { runId: token, output };
      } finally {
        await client.terminate(token).catch(() => undefined);
      }
    });
  }

  private pipelinePath(name: RebasePipelineName): string {
    return path.join(this.input.pipelineDir ?? defaultPipelineDir(), `${name}.pipe`);
  }
}

async function withRocketRideClient<T>(
  input: CreateRocketRideRunnerInput,
  callback: (client: RocketRideClientLike) => Promise<T>
): Promise<T> {
  const client =
    input.clientFactory?.(input) ??
    new RocketRideClient({
      uri: input.uri,
      auth: input.apiKey ?? process.env.ROCKETRIDE_APIKEY ?? "local",
      requestTimeout: 30_000,
      module: "rebase-coordinator"
    });
  await client.connect({
    uri: input.uri,
    ...(input.apiKey ? { auth: input.apiKey } : {}),
    timeout: 5_000
  });
  try {
    return await callback(client);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

interface RocketRideClientLike {
  connect(options?: { uri?: string; auth?: string; timeout?: number }): Promise<void>;
  disconnect(): Promise<void>;
  validate(options: { pipeline: Record<string, unknown> }): Promise<unknown>;
  use(options?: {
    filepath?: string | undefined;
    ttl?: number | undefined;
    pipelineTraceLevel?: "none" | "summary" | "full" | "metadata" | undefined;
  }): Promise<{ token: string }>;
  send(
    token: string,
    data: string | Uint8Array,
    objinfo?: Record<string, unknown>,
    mimetype?: string
  ): Promise<unknown>;
  terminate(token: string): Promise<void>;
}

type RocketRideClientFactory = (
  input: CreateRocketRideRunnerInput
) => RocketRideClientLike;

async function readPipelineConfig(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

function unwrapPipelineConfig(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.pipeline) ? config.pipeline : config;
}

function assertExecutablePipeline(
  filePath: string,
  config: Record<string, unknown>
): void {
  const source = typeof config.source === "string" ? config.source : "";
  if (!source) {
    throw new Error(`${path.basename(filePath)} is missing a source component`);
  }

  const components = Array.isArray(config.components) ? config.components : [];
  if (components.length === 0) {
    throw new Error(`${path.basename(filePath)} has no components`);
  }

  const sourceComponent = components.find(
    (component) =>
      isRecord(component) &&
      component.id === source &&
      isRecord(component.config) &&
      component.config.mode === "Source"
  );
  if (!sourceComponent) {
    throw new Error(
      `${path.basename(filePath)} source ${source} does not reference a Source component`
    );
  }

  const responseComponent = components.find(
    (component) => isRecord(component) && component.provider === "response"
  );
  if (!responseComponent) {
    throw new Error(`${path.basename(filePath)} is missing a response component`);
  }

  const rebaseComponent = components.find(
    (component) => isRecord(component) && component.provider === "rebase_coordination"
  );
  if (!rebaseComponent) {
    throw new Error(`${path.basename(filePath)} is missing a rebase_coordination component`);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/rebase_coordination|unknown provider|provider.*not found/i.test(message)) {
    return `${message}. Install the Rebase RocketRide node with \`pnpm rebase rocketride:sync --rocketride-server-dir=/path/to/rocketride-server\` or set ROCKETRIDE_SERVER_DIR.`;
  }
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultPipelineDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../pipelines"
  );
}
