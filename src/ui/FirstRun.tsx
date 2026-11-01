// The first-run card: over an empty viewport, the ways to start — sketch, a box,
// an example, the shortcuts. It goes once the document has anything in it, or
// for good when dismissed (remembered in this browser).

import { useState } from "react";
import { useStore } from "../model/store";
import { addPrimitive } from "./concepts/contextActions";
import { ExamplesMenu } from "./ExamplesMenu";

export const WELCOME_LS = "vibecad.welcome.dismissed";
// dismissed before, or the tutorial video's demo mode (?demo), which starts from an empty document on purpose
const dismissedBefore = () => {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("demo")) return true;
  try { return localStorage.getItem(WELCOME_LS) === "1"; } catch { return false; }
};

export function FirstRun() {
  const empty = useStore((s) => s.session.doc.operations.length === 0);
  const mode = useStore((s) => s.mode);
  const placing = useStore((s) => s.sketchPlacing);
  const [dismissed, setDismissed] = useState(dismissedBefore);
  if (!empty || dismissed || mode !== "model" || placing) return null;
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(WELCOME_LS, "1"); } catch { /* private window */ } };
  const st = useStore.getState;
  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <div className="first-run-head">
        <h2 id="first-run-title">Welcome to VibeCAD</h2>
        <button className="icon-btn" aria-label="Dismiss the welcome" title="Dismiss" onClick={dismiss}>✕</button>
      </div>
      <p className="first-run-text">Sketch, extrude and share parametric parts. Start here:</p>
      <div className="first-run-actions">
        <button className="btn primary" onClick={() => st().setSketchPlacing(true)}>Start a sketch</button>
        <button className="btn" onClick={() => void addPrimitive("box")}>Add a box</button>
        <ExamplesMenu label="Open an example" className="btn with-icon" />
        <button className="btn" onClick={() => st().setHotkeysOpen(true)}>Shortcuts <kbd>?</kbd></button>
      </div>
    </section>
  );
}
