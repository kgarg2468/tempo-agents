import { describe, expect, it } from "vitest";
import { createDisabledRocketRideCoordinator, runRocketRidePipeline } from "./rocketride.js";

describe("runRocketRidePipeline", () => {
  it("returns null when RocketRide is disabled for local development", async () => {
    await expect(
      runRocketRidePipeline(
        createDisabledRocketRideCoordinator(),
        "rebase-fingerprint",
        {}
      )
    ).resolves.toBeNull();
  });

  it("throws pipeline failures in required RocketRide mode", async () => {
    await expect(
      runRocketRidePipeline(
        {
          status: () => ({
            mode: "required",
            ok: true,
            uri: "http://127.0.0.1:5565",
            pipelineStatus: "validated",
            authoritative: true,
            message: "RocketRide required"
          }),
          async runPipeline() {
            throw new Error("pipeline failed");
          }
        },
        "rebase-fingerprint",
        {}
      )
    ).rejects.toThrow("pipeline failed");
  });
});
