import { activeSketch, useStore } from "../model/store";
import { Constraint, DimensionConstraint, isDimension } from "../sketch/types";

const dimLabel: Record<string, string> = {
  distance: "Distance", distanceX: "Horiz. dist", distanceY: "Vert. dist",
  pointLineDistance: "Pt→line", radius: "Radius", diameter: "Diameter", angle: "Angle",
};
const geomLabel: Record<string, string> = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel",
  perpendicular: "Perpendicular", equal: "Equal", pointOnLine: "Point on line", pointOnCircle: "Point on circle",
  concentric: "Concentric", tangent: "Tangent", symmetric: "Symmetric", fix: "Fixed",
};

const displayValue = (d: DimensionConstraint): string =>
  d.type === "angle" ? `${((d.value * 180) / Math.PI).toFixed(2)}°` : d.value.toFixed(3);

export function InspectorPanel() {
  const mode = useStore((s) => s.mode);
  useStore((s) => s.rev);
  const sk = useStore(activeSketch);
  const session = useStore((s) => s.session);
  const selection = useStore((s) => s.selection);
  const editDimension = useStore((s) => s.editDimension);
  const deleteConstraintById = useStore((s) => s.deleteConstraintById);
  const deleteSelected = useStore((s) => s.deleteSelected);

  if (mode !== "sketch" || !sk) {
    return (
      <div className="panel inspector">
        <div className="panel-head"><span>Inspector</span></div>
        <div className="inspector-empty">Enter a sketch to see constraints &amp; dimensions.</div>
      </div>
    );
  }

  const evaln = session.evaluations[sk.id];
  const conflicting = new Set(evaln?.diagnosis.conflicting ?? []);
  const constraints = Object.values(sk.constraints) as Constraint[];
  const dims = constraints.filter(isDimension) as DimensionConstraint[];
  const geoms = constraints.filter((c) => !isDimension(c));
  const status = sk.status;
  const statusClass = status.fullyConstrained ? "ok" : status.conflicting ? "bad" : "warn";

  return (
    <div className="panel inspector">
      <div className="panel-head"><span>Inspector</span></div>

      <div className={`solve-status ${statusClass}`}>
        <span className="status-dot" />
        <span>
          {status.fullyConstrained ? "Fully constrained"
            : status.conflicting ? "Over-constrained / conflicting"
            : `${status.dof} degree${status.dof === 1 ? "" : "s"} of freedom`}
        </span>
      </div>

      <div className="inspector-section">
        <div className="section-title">Dimensions ({dims.length})</div>
        {dims.length === 0 && <div className="muted">None</div>}
        {dims.map((d) => (
          <div className={`dim-row ${conflicting.has(d.id) ? "conflict" : ""}`} key={d.id}>
            <span className="dim-type">{dimLabel[d.type]}</span>
            <input
              className="dim-expr"
              defaultValue={d.expr}
              key={d.id + d.expr}
              onBlur={(e) => { if (e.target.value !== d.expr) editDimension(d.id, e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <span className="dim-val">{displayValue(d)}</span>
            <button className="icon-btn danger" onClick={() => deleteConstraintById(d.id)}>✕</button>
          </div>
        ))}
      </div>

      <div className="inspector-section">
        <div className="section-title">Geometric ({geoms.length})</div>
        {geoms.length === 0 && <div className="muted">None</div>}
        <div className="geom-chips">
          {geoms.map((c) => (
            <span className={`geom-chip ${conflicting.has(c.id) ? "conflict" : ""}`} key={c.id}>
              {geomLabel[(c as any).type] ?? (c as any).type}
              <button className="chip-x" onClick={() => deleteConstraintById(c.id)}>✕</button>
            </span>
          ))}
        </div>
      </div>

      {selection.length > 0 && (
        <div className="inspector-section">
          <div className="section-title">Selection</div>
          <div className="muted">{selection.length} entity(ies) selected</div>
          <button className="btn small" onClick={() => deleteSelected()}>Delete selected</button>
        </div>
      )}
    </div>
  );
}
