export const REQUIRED_REBASE_PIPELINES = [
  "rebase-fingerprint",
  "rebase-collision",
  "rebase-work-order",
  "rebase-merge-risk"
] as const;

export type RebasePipelineName = (typeof REQUIRED_REBASE_PIPELINES)[number];

export interface RocketRideStatus {
  mode: "required" | "disabled-dev";
  ok: boolean;
  uri: string | null;
  pipelineStatus: "unknown" | "validated" | "failed" | "disabled";
  authoritative: boolean;
  message: string;
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
    name: RebasePipelineName,
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
  name: RebasePipelineName,
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
