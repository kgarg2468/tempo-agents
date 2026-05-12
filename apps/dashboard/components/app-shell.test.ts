import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("AppShell", () => {
  it("renders the Tempo brand without a logo mark", async () => {
    const source = readFile(
      path.join(import.meta.dirname, "app-shell.tsx"),
      "utf8"
    );

    await expect(source).resolves.toContain("Tempo");
    await expect(source).resolves.not.toContain("brand-mark");
  });
});
