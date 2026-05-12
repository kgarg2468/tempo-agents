export const REQUIRED_TEMPO_PIPELINES = [
  "tempo-fingerprint",
  "tempo-collision",
  "tempo-work-order",
  "tempo-merge-risk"
] as const;

export type TempoPipelineName = (typeof REQUIRED_TEMPO_PIPELINES)[number];

export interface RocketRideStatus {
  mode: "required" | "disabled-dev";
  ok: boolean;
  uri: string | null;
  pipelineStatus: "unknown" | "validated" | "failed" | "disabled";
  authoritative: boolean;
  message: string;
  openAiPlanner?: {
    configured: boolean;
    validated: boolean;
  } | undefined;
  lastError?: string | undefined;
}

export interface RocketRidePipelineRun {
  runId: string;
  output?: unknown;
}

export interface RocketRideCoordinator {
  status(): RocketRideStatus;
  validateRequiredPipelines?(): Promise<RocketRideStatus>;
  runPipeline(
    name: TempoPipelineName,
    input: Record<string, unknown>
  ): Promise<RocketRidePipelineRun>;
}

export function createDisabledRocketRideCoordinator(
  reason = "RocketRide disabled for local coordinator development."
): RocketRideCoordinator {
  return {
    status: () => ({
      mode: "disabled-dev",
      ok: false,
      uri: null,
      pipelineStatus: "disabled",
      authoritative: false,
      message: reason
    }),
    async runPipeline() {
      throw new Error(reason);
    }
  };
}

export function isRocketRideRequired(
  rocketRide: RocketRideCoordinator | undefined
): boolean {
  return rocketRide?.status().mode === "required";
}

export async function runRocketRidePipeline(
  rocketRide: RocketRideCoordinator | undefined,
  name: TempoPipelineName,
  input: Record<string, unknown>
): Promise<RocketRidePipelineRun | null> {
  if (!rocketRide || rocketRide.status().mode === "disabled-dev") return null;
  try {
    return await rocketRide.runPipeline(name, input);
  } catch (error) {
    if (rocketRide.status().mode === "required") {
      throw error;
    }
    return null;
  }
}
