import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { activeSketch, useStore } from "../model/store";
import { availableOps, Op } from "../model/selectionOps";

// Explicit geometric-constraint palette (Fusion-style). Click a tool: if the
// current selection already satisfies it, it applies immediately; otherwise it
// enters a pick mode where you click the entities it needs.
const CONSTRAINT_TOOLS: { type: string; glyph: string; label: string; hint: string }[] = [
  { type: "coincident", glyph: "⟺", label: "Coincident", hint: "click two points" },
  { type: "collinear", glyph: "┈", label: "Collinear", hint: "click two lines" },
  { type: "concentric", glyph: "◎", label: "Concentric", hint: "click two circles / arcs" },
  { type: "midpoint", glyph: "▷◁", label: "Midpoint", hint: "click a point, then a line" },
  { type: "parallel", glyph: "∥", label: "Parallel", hint: "click two lines" },
  { type: "perpendicular", glyph: "⊥", label: "Perpendicular", hint: "click two lines" },
  { type: "horizontal", glyph: "—", label: "Horizontal", hint: "click a line (or two points)" },
  { type: "vertical", glyph: "|", label: "Vertical", hint: "click a line (or two points)" },
  { type: "equal", glyph: "=", label: "Equal", hint: "click two lines or two circles" },
  { type: "tangent", glyph: "◯", label: "Tangent", hint: "click a line & a circle, or two circles" },
  { type: "pointOnLine", glyph: "•—", label: "On Line", hint: "click a point, then a line" },
  { type: "pointOnCircle", glyph: "•◯", label: "On Circle", hint: "click a point, then a circle" },
  { type: "symmetric", glyph: "⧓", label: "Symmetric", hint: "click two points, then a line" },
  { type: "fix", glyph: "⚓", label: "Fix", hint: "click a point" },
];

export function ConstraintBar() {
  // the selection's actions float over the canvas: drawn into the viewport's box once it exists
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => { setHost(document.querySelector(".center-view")); }, []);
  const mode = useStore((s) => s.mode);
  const dispatch = useStore((s) => s.dispatch);
  const clearSelection = useStore((s) => s.clearSelection);
  const beginInlineEdit = useStore((s) => s.beginInlineEdit);
  const sk = useStore(activeSketch);
  const selection = useStore((s) => s.selection);
  const constraintTool = useStore((s) => s.constraintTool);
  const setConstraintTool = useStore((s) => s.setConstraintTool);

  if (mode !== "sketch" || !sk) return null;

  const { geometric, dimensions, modify } = availableOps(sk, selection);
  const geoFor = (type: string) => geometric.find((o) => (o.command.params as { type?: string }).type === type);

  const clickConstraint = (type: string) => {
    if (constraintTool === type) { setConstraintTool(null); return; }
    const op = geoFor(type);
    if (op) { void dispatch(op.command.type, op.command.params, { rejectOnConflict: true }); clearSelection(); }
    else setConstraintTool(type);
  };

  const applyDim = async (op: Op) => {
    if (op.command.type === "sketch.addDimension") {
      beginInlineEdit({ mode: "new", params: op.command.params, value: String(op.command.params.expression ?? ""), screen: { x: window.innerWidth / 2, y: 120 } });
    } else {
      await dispatch(op.command.type, op.command.params, { rejectOnConflict: true });
    }
    clearSelection();
  };

  const active = constraintTool ? CONSTRAINT_TOOLS.find((c) => c.type === constraintTool) : null;
  // With something selected, only the constraints that fit it can be pressed; with nothing, each arms a pick mode.
  const fits = (type: string) => selection.length === 0 || !!geoFor(type) || constraintTool === type;

  // One row of fixed height: what depends on the selection floats over the canvas below it, so selecting never
  // moves the canvas under the cursor (M8).
  return (
    <div className="constraint-bar-wrap">
    <div className="constraint-bar">
      <div className="cb-section">
        <span className="cb-title">Constrain</span>
        {CONSTRAINT_TOOLS.map((c) => (
          <button
            key={c.type}
            className={`chip ${constraintTool === c.type ? "armed" : geoFor(c.type) ? "ready" : ""}`}
            title={fits(c.type) ? `${c.label} — ${c.hint}` : `${c.label} doesn't fit the selection (Esc clears it, then ${c.hint})`}
            disabled={!fits(c.type)}
            onClick={() => clickConstraint(c.type)}
          >
            <span className="chip-glyph">{c.glyph}</span>
            {c.label}
          </button>
        ))}
      </div>
    </div>
    {(() => { const float = (
    <div className="cb-float" aria-live="polite">
      {(dimensions.length > 0 || modify.length > 0) && (
        <div className="cb-section cb-actions" role="toolbar" aria-label="For the selection">
          {dimensions.length > 0 && <span className="cb-title">Dimension</span>}
          {dimensions.map((op) => (
            <button key={op.id} className="chip dim" title={op.hint} onClick={() => applyDim(op)}>
              <span className="chip-glyph">{op.glyph}</span>{op.label}
            </button>
          ))}
          {modify.length > 0 && <span className="cb-title">Modify</span>}
          {modify.map((op) => (
            <button key={op.id} className="chip mod" title={op.hint} onClick={() => applyDim(op)}>
              <span className="chip-glyph">{op.glyph}</span>{op.label}
            </button>
          ))}
        </div>
      )}
      {active && (
        <div className="cb-hint active-hint">
          <b>{active.label}</b>: {active.hint} · {selection.length} picked · <kbd>Esc</kbd> to stop
        </div>
      )}
    </div>); return host ? createPortal(float, host) : float; })()}
    </div>
  );
}
