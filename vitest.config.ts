import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@rebase/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@rebase/coordinator": new URL(
        "./packages/coordinator/src/index.ts",
        import.meta.url
      ).pathname
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000
  }
});
