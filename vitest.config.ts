import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit/integration tests for the pure, renderer-agnostic core (no DOM/WebGL)
// run in Node: the constraint solver (PlaneGCS) and the OCC kernel load their
// wasm there. UI component tests live under test/ui/ and run in jsdom with
// Testing Library (no WebGL: the viewport itself is never mounted there).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environmentMatchGlobs: [["test/ui/**", "jsdom"]],
    setupFiles: ["test/ui/setup.ts"],
    css: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
