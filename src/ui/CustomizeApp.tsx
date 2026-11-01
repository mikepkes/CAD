// Customize mode: a slider-only product-tuning view. Loads a model from the
// URL (?model=<url> or ?example=<name>) and shows just the 3D preview with the
// bounded parameters as sliders/dropdowns overlaid, so an end user can dial the
// product to their dimensions. Dragging a control updates the preview smoothly
// (local value + throttled, coalesced rebuilds); the motion study runs only
// after the user goes idle and is cancelled the moment they touch a control
// again, so it never churns through the values a drag passed through.

import { useCallback, useEffect, useRef, useState } from "react";
import { Viewport } from "./Viewport";
import { useStore } from "../model/store";
import { deserializeDocument } from "../core/persistence";
import { editCommitter } from "./editCommitter";
import { DrawingView } from "./DrawingView";
import { Control, FlexureReadout, MotionBadge, SaveButton } from "./CustomizeControls";
import { Toast } from "./Toast";

// The 3D rebuild is the slow part, so the slider's own value updates live while
// the model is rebuilt only when you briefly pause or release (debounce, not
// per-frame), and the (secondary) motion study runs only well after you stop.
const IDLE_MS = 2000;   // run the motion study after this long with no interaction
const COMMIT_MS = 200;  // debounce: rebuild the model this long after the last move

function modelUrl(): string | null {
  const q = new URLSearchParams(location.search);
  const model = q.get("model");
  if (model) return model;
  const example = q.get("example");
  if (example) return `${import.meta.env.BASE_URL}examples/${encodeURIComponent(example)}.json`;
  return null;
}

export function CustomizeApp() {
  const loadDocument = useStore((s) => s.loadDocument);
  const ensureKernel = useStore((s) => s.ensureKernel);
  const runMotionStudy = useStore((s) => s.runMotionStudy);
  const cancelMotionStudy = useStore((s) => s.cancelMotionStudy);
  const shareModel = useStore((s) => s.shareModel);
  const params = useStore((s) => s.session.doc.parameters);
  const hasDrawing = useStore((s) => !!s.session.doc.drawing);
  const openDrawing = useStore((s) => s.openDrawing);
  useStore((s) => s.rev); // re-render as the model resolves
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);

  const idle = useRef<ReturnType<typeof setTimeout>>();

  // Run the study only after the user has been idle; any edit restarts the wait.
  const armStudy = useCallback(() => {
    cancelMotionStudy();
    clearTimeout(idle.current);
    idle.current = setTimeout(() => void runMotionStudy(), IDLE_MS);
  }, [cancelMotionStudy, runMotionStudy]);

  // Commit a control's value to the model after a pause (see editCommitter). The
  // slider's own number tracks every move regardless (Control keeps a local value).
  const committer = useRef(editCommitter((n, v) => useStore.getState().setParameterExpr(n, v), COMMIT_MS));
  const onEdit = useCallback((name: string, value: string, flush: boolean) => {
    armStudy();
    committer.current.edit(name, value, flush);
  }, [armStudy]);

  useEffect(() => {
    void (async () => {
      try {
        useStore.setState({ showPlanes: false, showGrid: false }); // clean product view
        await ensureKernel();
        const url = modelUrl();
        if (!url) throw new Error("No model given. Add ?model=<url> or ?example=gyroscope to the link.");
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Could not load model (${resp.status}).`);
        await loadDocument(deserializeDocument(await resp.text()));
        // frame it: the default camera suits a small part, and sits inside anything the size of a workbench
        window.dispatchEvent(new CustomEvent("vibecad:view", { detail: "iso" }));
        window.dispatchEvent(new CustomEvent("vibecad:frame"));
        setState("ready");
        armStudy(); // validate the starting configuration once
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      }
    })();
    return () => { clearTimeout(idle.current); committer.current.cancel(); };
  }, [ensureKernel, loadDocument, armStudy]);

  const bounded = params.filter((p) => (p.min != null && p.max != null) || (p.values && p.values.length));

  return (
    <div className="customize">
      <Viewport />
      <MotionBadge />
      {state === "ready" && bounded.length > 0 && (
        <div className={`cz-panel ${open ? "" : "collapsed"}`}>
          <button className="cz-handle" onClick={() => setOpen((v) => !v)} title={open ? "Hide controls" : "Show controls"}>
            <span>Customize</span><span className="cz-chevron">{open ? "▾" : "▴"}</span>
          </button>
          {open && (
            <div className="cz-controls">
              {bounded.map((p) => <Control key={p.id} name={p.name} value={p.value} expr={p.expr} min={p.min} max={p.max} step={p.step} values={p.values} boolean={p.boolean} options={p.options} onEdit={onEdit} />)}
              <FlexureReadout />
              {hasDrawing && (
                <button className="cz-drawing" title="The design's shop drawing: views, dimensions and the cut list, as a PDF" onClick={() => void openDrawing()}>
                  ▤ Drawing (PDF)
                </button>
              )}
              <SaveButton onSave={() => void shareModel(new URLSearchParams(location.search).get("example") || "model", { flush: () => committer.current.flush() })} />
            </div>
          )}
        </div>
      )}
      <DrawingView viewer />
      <Toast />
      {state === "loading" && <div className="cz-overlay">Loading…</div>}
      {state === "error" && <div className="cz-overlay error">{error}</div>}
    </div>
  );
}
