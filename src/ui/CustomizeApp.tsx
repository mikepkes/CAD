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
import { Control, FlexureReadout, LoadingOverlay, LoadProblem, MotionBadge, SaveButton, modelTitle, viewerControls, type LoadFailure } from "./CustomizeControls";
import { BuildProgress } from "./BuildProgress";
import { Toast } from "./Toast";
import { exampleUrl } from "../model/examples";

// The 3D rebuild is the slow part, so the slider's own value updates live while
// the model is rebuilt only when you briefly pause or release (debounce, not
// per-frame), and the (secondary) motion study runs only well after you stop.
const IDLE_MS = 2000;   // run the motion study after this long with no interaction
const COMMIT_MS = 200;  // debounce: rebuild the model this long after the last move

/** What the link asks for: an example by name, or a model by URL. */
function requested(): { url: string; example?: string } | null {
  const q = new URLSearchParams(location.search);
  const model = q.get("model");
  if (model) return { url: model };
  const example = q.get("example");
  if (example) return { url: exampleUrl(example), example };
  return null;
}

export function CustomizeApp() {
  const loadDocument = useStore((s) => s.loadDocument);
  const ensureKernel = useStore((s) => s.ensureKernel);
  const runMotionStudy = useStore((s) => s.runMotionStudy);
  const cancelMotionStudy = useStore((s) => s.cancelMotionStudy);
  const shareModel = useStore((s) => s.shareModel);
  const doc = useStore((s) => s.session.doc);
  const hasDrawing = useStore((s) => !!s.session.doc.drawing);
  const openDrawing = useStore((s) => s.openDrawing);
  useStore((s) => s.rev); // re-render as the model resolves
  const [state, setState] = useState<"loading" | "building" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [open, setOpen] = useState(true);
  const req = useRef(requested());
  const example = req.current?.example;

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
        useStore.setState({ showPlanes: false, showGrid: false, showAxes: false }); // clean product view
        const r = req.current;
        if (!r) { setFailure({ kind: "none" }); setState("error"); return; }
        // the kernel (a big download) and the model load side by side
        const kernel = ensureKernel();
        let text: string;
        try {
          const resp = await fetch(r.url);
          text = await resp.text();
          // a missing file comes back as a 404, or as the app's own page from a server that serves it for any path
          if (!resp.ok || /^\s*</.test(text)) { setFailure({ kind: "missing", example: r.example, url: r.url }); setState("error"); return; }
        } catch {
          setFailure({ kind: "offline", example: r.example, url: r.url }); setState("error"); return;
        }
        let parsed;
        try { parsed = deserializeDocument(text); } catch (e) {
          setFailure({ kind: "unreadable", example: r.example, url: r.url, detail: (e as Error).message }); setState("error"); return;
        }
        await kernel;
        setState("building");
        await loadDocument(parsed);
        // frame it: the default camera suits a small part, and sits inside anything the size of a workbench
        window.dispatchEvent(new CustomEvent("vibecad:view", { detail: "iso" }));
        setState("ready");
        armStudy(); // validate the starting configuration once
      } catch (e) {
        setFailure({ kind: "unreadable", example: req.current?.example, url: req.current?.url ?? "", detail: (e as Error).message });
        setState("error");
      }
    })();
    return () => { clearTimeout(idle.current); committer.current.cancel(); };
  }, [ensureKernel, loadDocument, armStudy]);

  const title = state === "ready" ? modelTitle(doc, example) : modelTitle(null, example);
  const intro = state === "ready" ? doc.about?.description : undefined;
  useEffect(() => {
    document.title = state === "error" ? "Model not found · VibeCAD" : `${title} · VibeCAD`;
  }, [title, state]);

  const controls = viewerControls(doc.parameters);

  return (
    <div className="customize">
      <Viewport label={`3D view of ${title}. Drag to turn it; pinch or scroll to zoom.`} />
      <MotionBadge />
      {state === "ready" && (
        <section className={`cz-panel ${open ? "" : "collapsed"}`} aria-labelledby="cz-title">
          {/* the whole head row toggles the sheet; the button is what a keyboard or screen reader uses */}
          <div className="cz-head" onClick={() => setOpen((v) => !v)}>
            <h1 className="cz-title" id="cz-title">{title}</h1>
            <button className="cz-handle" aria-expanded={open} aria-controls="cz-body" aria-label={open ? "Hide the controls" : "Show the controls"} title={open ? "Hide the controls" : "Show the controls"}>
              <span className="cz-chevron" aria-hidden="true">{open ? "▾" : "▴"}</span>
            </button>
          </div>
          {open && (
            <>
              <div className="cz-controls" id="cz-body">
                {intro && <p className="cz-intro">{intro}</p>}
                {controls.map((p) => (
                  <Control key={p.id} name={p.name} label={p.label} unit={p.unit} description={p.description} value={p.value} expr={p.expr}
                    min={p.min} max={p.max} step={p.step} values={p.values} boolean={p.boolean} options={p.options} onEdit={onEdit} />
                ))}
                <FlexureReadout />
              </div>
              {/* Save and the drawing stay in reach, outside the scrolling controls */}
              <div className="cz-foot">
                {hasDrawing && (
                  <button className="cz-drawing" title="The design's shop drawing: views, dimensions and the cut list, as a PDF" onClick={() => void openDrawing()}>
                    ▤ Drawing (PDF)
                  </button>
                )}
                <SaveButton onSave={() => void shareModel(example || "model", { flush: () => committer.current.flush() })} />
              </div>
            </>
          )}
        </section>
      )}
      <DrawingView viewer />
      <Toast />
      {state === "ready" && <BuildProgress />}
      {(state === "loading" || state === "building") && <LoadingOverlay phase={state} name={title} />}
      {state === "error" && failure && <LoadProblem failure={failure} />}
    </div>
  );
}
