import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { CustomizeApp } from "./ui/CustomizeApp";
import "./styles.css";

// Slider-only customize mode is selected by the URL (?mode=customize or
// ?customize), so a model link can open straight into end-user tuning.
const q = new URLSearchParams(location.search);
const customize = q.get("mode") === "customize" || q.has("customize");

createRoot(document.getElementById("root")!).render(customize ? <CustomizeApp /> : <App />);

// DEV-only automation hook: load a serialized document, wait for its bodies to
// build, render a turntable, and return the WebM as base64. Used by the batch
// asset-reel tooling; never shipped to users (gated on import.meta.env.DEV).
if (import.meta.env?.DEV) {
  (window as unknown as { __renderDoc?: unknown }).__renderDoc = async (json: string, opts?: Record<string, unknown>) => {
    const { useStore } = await import("./model/store");
    const { deserializeDocument } = await import("./core/persistence");
    const { recordTurntable } = await import("./viewport/recordTurntable");
    const st = useStore.getState();
    await st.ensureKernel();
    await st.loadDocument(deserializeDocument(json));
    // Wait until the kernel has produced at least one mesh (or give up).
    for (let i = 0; i < 400; i++) {
      const solids = Object.values(useStore.getState().solids);
      if (solids.length && solids.every((s) => s.mesh || s.error)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const solids = Object.values(useStore.getState().solids);
    const { blob } = await recordTurntable(solids, opts as Record<string, never>);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return btoa(bin);
  };
}
