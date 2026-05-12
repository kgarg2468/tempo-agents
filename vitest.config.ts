import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tempo/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@tempo/coordinator": new URL(
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
