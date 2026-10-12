import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Windows CI runners spawn processes and Git markedly slower: in the
    // round-000 retro, 3 of the 11 CI runs with a failed platform job hit
    // the 30 s limit on Windows only, 2 of them with no other failure. A
    // test's own explicit limit still applies.
    testTimeout: process.platform === "win32" ? 60000 : 30000,
    hookTimeout: process.platform === "win32" ? 60000 : 30000,
  },
});
