import { defineConfig } from "vitest/config";

// Unit/integration tests for the pure, renderer-agnostic core (no DOM/WebGL).
// The constraint solver (PlaneGCS) and the OCC kernel load their wasm in Node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
