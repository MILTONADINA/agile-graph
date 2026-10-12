import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Windows CI runners spawn processes and Git markedly slower: in the
    // round-000 retro, 4 of 8 failed CI runs were integration tests passing
    // the 30 s limit there only. A test's own explicit limit still applies.
    testTimeout: process.platform === "win32" ? 60000 : 30000,
    hookTimeout: process.platform === "win32" ? 60000 : 30000,
  },
});
