import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit/integration tests for the pure, renderer-agnostic core (no DOM/WebGL)
// run in Node: the constraint solver (PlaneGCS) and the OCC kernel load their
// wasm there. UI component tests live under test/ui/ and run in jsdom with
// Testing Library (no WebGL: the viewport itself is never mounted there).
//
// Two runs (see README, Testing):
//   npm test            the default run: every unit and UI test, every bundled
//                       example built, snapshotted and collision-checked, each
//                       generator checked against its committed example;
//   npm run test:full   (`vitest run --mode full`) also the extended checks:
//                       the generators' material / slider-corner / pose sweeps
//                       and the examples' dense motion sweeps. Marked in the
//                       tests with `itFull` / `describeFull` (test/helpers.ts).
//   npm run test:origami (`vitest run --mode origami`) only the paper-folding
//                       tests in test/origami/: folding is experimental, so its
//                       checks stay out of `npm test` (and CI) until it isn't.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    environment: "node",
    include: mode === "origami" ? ["test/origami/**/*.test.ts", "test/origami/**/*.test.tsx"] : ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: mode === "origami" ? ["**/node_modules/**"] : ["**/node_modules/**", "test/origami/**"],
    environmentMatchGlobs: [["test/ui/**", "jsdom"], ["test/origami/ui/**", "jsdom"]],
    setupFiles: ["test/ui/setup.ts"],
    css: false,
    // Generous enough for a kernel test on a loaded machine; a test that needs
    // more says so (and belongs in the extended run, most likely).
    testTimeout: 60000,
    hookTimeout: 60000,
    env: mode === "full" ? { VIBECAD_TEST_FULL: "1" } : {},
  },
}));
