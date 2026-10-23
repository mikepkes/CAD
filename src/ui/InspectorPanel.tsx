import { activeSketch, useStore } from "../model/store";
import { Constraint, DimensionConstraint, isDimension } from "../sketch/types";

const dimLabel: Record<string, string> = {
  distance: "Distance", distanceX: "Horiz. dist", distanceY: "Vert. dist",
  pointLineDistance: "Pt→line", radius: "Radius", diameter: "Diameter", angle: "Angle",
};
const geomLabel: Record<string, string> = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel",
  perpendicular: "Perpendicular", collinear: "Collinear", equal: "Equal", pointOnLine: "Point on line",
  pointOnCircle: "Point on circle", concentric: "Concentric", tangent: "Tangent", symmetric: "Symmetric",
  fix: "Fixed", midpoint: "Midpoint",
};

const displayValue = (d: DimensionConstraint): string =>
  d.type === "angle" ? `${((d.value * 180) / Math.PI).toFixed(2)}°` : d.value.toFixed(3);

function ModelInspector() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const solids = useStore((s) => s.solids);
  const editFeatureDistance = useStore((s) => s.editFeatureDistance);
  const deleteFeature = useStore((s) => s.deleteFeature);
  const features = Object.values(session.doc.features);

  return (
    <div className="panel inspector">
      <div className="panel-head"><span>Inspector</span></div>
      <div className="inspector-section">
        <div className="section-title">Bodies / Features ({features.length})</div>
        {features.length === 0 && (
          <div className="muted">Finish a sketch, then press ⬆ Extrude to make a solid.</div>
        )}
        {features.map((f) => {
          const sol = solids[f.id];
          return (
            <div className="dim-row" key={f.id} style={{ gridTemplateColumns: "1fr 1fr 60px 22px" }}>
              <span className="dim-type" title={`Extrude of ${f.sketchId}`}>{f.name}</span>
              <input
                className="dim-expr"
                defaultValue={f.distanceExpr}
                key={f.id + f.distanceExpr}
                onBlur={(e) => { if (e.target.value !== f.distanceExpr) editFeatureDistance(f.id, e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <span className="dim-val" title={sol?.error}>
                {sol?.error ? "⚠" : sol?.mesh ? `${f.distanceValue.toFixed(2)}` : "…"}
              </span>
              <button className="icon-btn danger" onClick={() => deleteFeature(f.id)}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const mode = useStore((s) => s.mode);
  useStore((s) => s.rev);
  const sk = useStore(activeSketch);
  const session = useStore((s) => s.session);
  const selection = useStore((s) => s.selection);
  const editDimension = useStore((s) => s.editDimension);
  const toggleDrivenDimension = useStore((s) => s.toggleDrivenDimension);
  const deleteConstraintById = useStore((s) => s.deleteConstraintById);
  const deleteSelected = useStore((s) => s.deleteSelected);

  if (mode !== "sketch" || !sk) {
    return <ModelInspector />;
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
          <div className={`dim-row ${conflicting.has(d.id) ? "conflict" : ""} ${d.driven ? "driven" : ""}`} key={d.id} style={{ gridTemplateColumns: "1fr 1fr 48px 22px 22px" }}>
            <span className="dim-type">{dimLabel[d.type]}</span>
            <input
              className="dim-expr"
              defaultValue={d.expr}
              key={d.id + d.expr + (d.driven ? "ref" : "")}
              disabled={d.driven}
              title={d.driven ? "Reference dimension — measured, not driving" : undefined}
              onBlur={(e) => { if (e.target.value !== d.expr) editDimension(d.id, e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <span className="dim-val">{d.driven ? `(${displayValue(d)})` : displayValue(d)}</span>
            <button
              className={`icon-btn ${d.driven ? "active" : ""}`}
              title={d.driven ? "Make driving dimension" : "Make reference (driven) dimension"}
              onClick={() => toggleDrivenDimension(d.id)}
            >
              ⟨⟩
            </button>
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
