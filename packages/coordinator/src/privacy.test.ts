import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactForCloud } from "./privacy.js";

describe("cloud privacy redaction", () => {
  it("redacts secrets and .rebaseignore paths before cloud escalation", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "rebase-redact-"));
    await mkdir(path.join(repoRoot, "secrets"), { recursive: true });
    await writeFile(path.join(repoRoot, ".rebaseignore"), ".env\nsecrets/\n");

    const result = redactForCloud(
      {
        prompt: "Use OPENAI_API_KEY=sk-test1234567890 and inspect secrets/token.txt.",
        filePaths: ["src/db/schema.ts", "secrets/token.txt", ".env"],
        metadata: {
          bearer: "Bearer sk-other1234567890",
          command: "cat secrets/token.txt"
        }
      },
      repoRoot
    );
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("sk-test1234567890");
    expect(serialized).not.toContain("sk-other1234567890");
    expect(serialized).not.toContain("secrets/token.txt");
    expect(serialized).not.toContain(".env");
    expect(result.redactions).toEqual(
      expect.arrayContaining(["secret", "path:secrets/token.txt", "path:.env"])
    );
  });
});
