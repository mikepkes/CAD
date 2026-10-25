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
    return toBase64(await blob.arrayBuffer());
  };
  // DEV-only: load a doc and render its MOTION study (joints driven through their
  // range) to a WebM. Used to demonstrate mechanisms.
  (window as unknown as { __renderMotion?: unknown }).__renderMotion = async (json: string, opts?: Record<string, unknown>) => {
    const { useStore } = await import("./model/store");
    const { deserializeDocument } = await import("./core/persistence");
    const { recordMotionStudy } = await import("./viewport/recordMotion");
    const st = useStore.getState();
    await st.ensureKernel();
    await st.loadDocument(deserializeDocument(json));
    for (let i = 0; i < 600; i++) {
      const solids = Object.values(useStore.getState().solids);
      if (solids.length && solids.every((s) => s.mesh || s.error)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const s = useStore.getState();
    const { blob } = await recordMotionStudy(s.session.doc, Object.values(s.solids), opts as Record<string, never>);
    return toBase64(await blob.arrayBuffer());
  };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
