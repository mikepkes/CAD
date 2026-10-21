import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // Relative base in the production build so the app works at a project-site
  // subpath (e.g. https://<user>.github.io/CAD/) without hardcoding the repo
  // name. Dev server keeps an absolute base.
  base: command === "build" ? "./" : "/",
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  // The OpenCASCADE emscripten glue has a `new URL('…wasm', import.meta.url)`
  // fallback that Vite's dep-scanner can't resolve (the package's exports map
  // blocks the deep path). We never hit that branch — we pass the wasm URL via
  // locateFile — so exclude it from pre-bundling.
  optimizeDeps: {
    exclude: ["replicad-opencascadejs"],
  },
  build: {
    target: "es2020",
    sourcemap: true,
  },
}));
