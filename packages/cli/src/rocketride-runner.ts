import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RocketRideClient } from "rocketride";
import type {
  TempoPipelineName,
  RocketRideCoordinator,
  RocketRidePipelineRun,
  RocketRideStatus
} from "@tempo/coordinator";
import {
  parsePipelineRunOutput,
  REQUIRED_TEMPO_PIPELINES,
  smokeInputForPipeline
} from "@tempo/coordinator";

export interface CreateRocketRideRunnerInput {
  uri: string;
  apiKey?: string | undefined;
  pipelineDir?: string | undefined;
  clientFactory?: RocketRideClientFactory | undefined;
  operationTimeoutMs?: number | undefined;
  disconnectTimeoutMs?: number | undefined;
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
        for (const pipeline of REQUIRED_TEMPO_PIPELINES) {
          const pipelinePath = this.pipelinePath(pipeline);
          const config = await readPipelineConfig(pipelinePath);
          const pipelineConfig = unwrapPipelineConfig(config);
          assertExecutablePipeline(pipelinePath, pipelineConfig);
          try {
            const smokeInput = smokeInputForPipeline(pipeline);
            if (pipeline === "tempo-work-order" && process.env.OPENAI_API_KEY) {
              smokeInput.plannerMode = "required";
            }
            await withTimeout(
              client.validate({ pipeline: pipelineConfig }),
              operationTimeoutMs(this.input),
              `${pipeline} validate`
            );
            const { token } = await withTimeout(
              client.use({
                filepath: pipelinePath,
                ttl: 60,
                pipelineTraceLevel: "summary"
              }),
              operationTimeoutMs(this.input),
              `${pipeline} use`
            );
            try {
              const output = await withTimeout(
                client.send(
                  token,
                  JSON.stringify(smokeInput),
                  { name: `${pipeline}.smoke.json` },
                  "text/plain"
                ),
                operationTimeoutMs(this.input),
                `${pipeline} send`
              );
              parsePipelineRunOutput(pipeline, output);
            } finally {
              await terminatePipeline(client, token, this.input, pipeline);
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
        message: "RocketRide pipelines validated.",
        openAiPlanner: {
          configured: Boolean(process.env.OPENAI_API_KEY),
          validated: Boolean(process.env.OPENAI_API_KEY)
        }
      };
    } catch (error) {
      this.lastStatus = {
        mode: "required",
        ok: false,
        uri: this.input.uri,
        pipelineStatus: "failed",
        authoritative: false,
        message: "RocketRide pipeline validation failed.",
        openAiPlanner: {
          configured: Boolean(process.env.OPENAI_API_KEY),
          validated: false
        },
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
    return this.lastStatus;
  }

  async runPipeline(
    name: TempoPipelineName,
    input: Record<string, unknown>
  ): Promise<RocketRidePipelineRun> {
    return withRocketRideClient(this.input, async (client) => {
      const { token } = await withTimeout(
        client.use({
          filepath: this.pipelinePath(name),
          ttl: 300,
          pipelineTraceLevel: "summary"
        }),
        operationTimeoutMs(this.input),
        `${name} use`
      );
      try {
        const output = await withTimeout(
          client.send(
            token,
            JSON.stringify(input),
            { name: `${name}.input.json` },
            "text/plain"
          ),
          operationTimeoutMs(this.input),
          `${name} send`
        );
        return { runId: token, output };
      } finally {
        await terminatePipeline(client, token, this.input, name);
      }
    }).catch((error) => {
      throw new Error(`${name}: ${errorMessage(error)}`);
    });
  }

  private pipelinePath(name: TempoPipelineName): string {
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
      module: "tempo-coordinator"
    });
  await withTimeout(
    client.connect({
      uri: input.uri,
      ...(input.apiKey ? { auth: input.apiKey } : {}),
      timeout: 5_000
    }),
    Math.max(7_000, Math.min(operationTimeoutMs(input), 30_000)),
    "RocketRide connect"
  );
  try {
    return await callback(client);
  } finally {
    await disconnectClient(client, input);
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

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 2_000;

function operationTimeoutMs(input: CreateRocketRideRunnerInput): number {
  return input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
}

function disconnectTimeoutMs(input: CreateRocketRideRunnerInput): number {
  return input.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS;
}

async function terminatePipeline(
  client: RocketRideClientLike,
  token: string,
  input: CreateRocketRideRunnerInput,
  pipeline: TempoPipelineName
): Promise<void> {
  await withTimeout(
    client.terminate(token),
    disconnectTimeoutMs(input),
    `${pipeline} terminate`
  ).catch(() => undefined);
}

async function disconnectClient(
  client: RocketRideClientLike,
  input: CreateRocketRideRunnerInput
): Promise<void> {
  const disconnected = await withTimeout(
    client.disconnect(),
    disconnectTimeoutMs(input),
    "RocketRide disconnect"
  )
    .then(() => true)
    .catch(() => false);

  if (!disconnected) {
    forceCloseClient(client);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function forceCloseClient(client: RocketRideClientLike): void {
  const maybeClient = client as unknown as {
    _clearReconnectTimeout?: () => void;
    _transport?: {
      _stopPingInterval?: () => void;
      _websocket?: {
        terminate?: () => void;
        close?: () => void;
        removeAllListeners?: () => void;
      };
      _connected?: boolean;
    };
  };
  maybeClient._clearReconnectTimeout?.();
  const transport = maybeClient._transport;
  transport?._stopPingInterval?.();
  const websocket = transport?._websocket;
  websocket?.removeAllListeners?.();
  if (typeof websocket?.terminate === "function") {
    websocket.terminate();
  } else {
    websocket?.close?.();
  }
  if (transport) {
    transport._connected = false;
  }
}

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

  const tempoComponent = components.find(
    (component) => isRecord(component) && component.provider === "tempo_coordination"
  );
  if (!tempoComponent) {
    throw new Error(`${path.basename(filePath)} is missing a tempo_coordination component`);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/tempo_coordination|unknown provider|provider.*not found/i.test(message)) {
    return `${message}. Install the Tempo RocketRide node with \`pnpm tempo rocketride:sync --rocketride-server-dir=/path/to/rocketride-server\` or set ROCKETRIDE_SERVER_DIR.`;
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
