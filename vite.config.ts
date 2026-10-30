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
    // The optional Tauri shell (`npm run tauri:dev`) points at this exact port.
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // The OpenCASCADE emscripten glue has a `new URL('…wasm', import.meta.url)`
  // fallback that Vite's dep-scanner can't resolve (the package's exports map
  // blocks the deep path). We never hit that branch — we pass the wasm URL via
  // locateFile — so exclude it from pre-bundling.
  // rhino3dm is served as its ESM build untouched: pre-bundling would try to
  // resolve the Node-only `require("ws")` inside its emscripten glue.
  optimizeDeps: {
    exclude: ["replicad-opencascadejs", "rhino3dm"],
    // Pre-bundle the turntable recorder's muxer so importing it at runtime
    // doesn't trigger a dep re-optimize + full page reload mid-recording.
    include: ["mp4-muxer"],
  },
  build: {
    target: "es2020",
    sourcemap: true,
  },
}));
