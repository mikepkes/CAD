import { activeSketch, useStore } from "../model/store";
import { EyeToggle } from "./EyeToggle";
import { groupCutList, cutListCsv } from "../core/weldment";
import { flatPatternSvg, flatPatternDxf } from "../core/sheet";
import { saveOutput, sanitizeOutputName } from "../model/saveOutput";
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

/** The weldment cut list: identical members grouped, with a CSV export. */
function CutList() {
  const solids = useStore((s) => s.solids);
  const pieces = Object.values(solids).filter((b) => b.member).map((b) => ({ body: b.featureId, ...b.member! }));
  if (!pieces.length) return null;
  const rows = groupCutList(pieces);
  const save = () => void saveOutput("cut list.csv", new TextEncoder().encode(cutListCsv(rows)), "text/csv");
  return (
    <div className="inspector-section">
      <div className="section-title">Cut list ({pieces.length}) <button className="icon-btn" title="Save as CSV" onClick={save}>⇩</button></div>
      {rows.map((r, i) => (
        <div className="dim-row" key={i} style={{ gridTemplateColumns: "1fr 64px 70px 28px" }} title={r.bodies.join(", ")}>
          <span className="dim-type">{r.profile}</span>
          <span className="dim-val">{r.length}</span>
          <span className="muted-inline">{r.angles[0]}° / {r.angles[1]}°</span>
          <span className="dim-val">×{r.quantity}</span>
        </div>
      ))}
    </div>
  );
}

/** Each sheet-metal / paper body's flat size and folds, with SVG / DXF exports of the flat pattern. */
function FlatPatterns() {
  const solids = useStore((s) => s.solids);
  const sheets = Object.values(solids).filter((b) => b.sheet);
  if (!sheets.length) return null;
  const save = (name: string, flat: NonNullable<(typeof sheets)[number]["sheet"]>["flat"], ext: "svg" | "dxf") =>
    void saveOutput(sanitizeOutputName(`${name} flat`, ext, "flat pattern"), new TextEncoder().encode(ext === "svg" ? flatPatternSvg(flat) : flatPatternDxf(flat)), ext === "svg" ? "image/svg+xml" : "application/dxf");
  return (
    <div className="inspector-section">
      <div className="section-title">Flat patterns ({sheets.length})</div>
      {sheets.map((b) => {
        const sh = b.sheet!, f = sh.flat;
        const ups = f.folds.filter((x) => x.angle > 0).length, downs = f.folds.length - ups;
        return (
          <div className="dim-row" key={b.featureId} style={{ gridTemplateColumns: "1fr 1fr 28px 28px" }}
            title={f.folds.map((x) => `${x.id}: ${x.angle.toFixed(1)}°${x.radius > 0 ? ` R${x.radius} BA ${x.allowance.toFixed(3)}` : " crease"}`).join("\n") + (sh.stale ? "\n(stale: changed while folded)" : "")}>
            <span className="dim-type">{b.name}{sh.stale ? " ⚠" : ""}</span>
            <span className="muted-inline">{(f.max.x - f.min.x).toFixed(1)} × {(f.max.y - f.min.y).toFixed(1)} · {ups}↑ {downs}↓</span>
            <button className="icon-btn" title="Save flat pattern as SVG" onClick={() => save(b.name, f, "svg")}>⇩</button>
            <button className="icon-btn" title="Save flat pattern as DXF" onClick={() => save(b.name, f, "dxf")}>⌗</button>
          </div>
        );
      })}
    </div>
  );
}

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
          if (f.kind !== "extrude") {
            // Modifier features (mirror, fillet, shell, pattern, revolve): name + a one-word detail + status.
            const detail =
              f.kind === "mirror" ? `⟷ ${f.plane}` :
              f.kind === "revolve" ? `↻ ${f.angleExpr}°` :
              f.kind === "shell" ? `t=${f.thicknessExpr}` :
              f.kind === "pattern" ? `×${f.count}` :
              f.kind === "loft" ? `⤳ ${f.sketchIds.length}` :
              f.kind === "sweep" ? "⟿ path" :
              f.kind === "primitive" ? `◧ ${f.shape}` :
              f.kind === "import" ? `⇩ ${f.format.toUpperCase()}` :
              f.kind === "member" ? `⌸ ${f.profile.kind.replace("_", " ")}` :
              f.kind === "sheet" ? `▱ t=${f.thicknessExpr}${f.folds?.length ? ` · ${f.folds.length} folds` : ""}` :
              f.kind === "flange" ? `⌐ ${f.hem ? "hem" : `${f.angleExpr ?? "90"}°`} ${f.lengthExpr}` :
              f.kind === "fold" ? (f.jogExpr ? `⎍ jog ${f.jogExpr}` : `∠ ${f.angleExpr}°`) :
              f.kind === "unfold" ? "▭ flat" :
              f.kind === "refold" ? "⌐ folded" :
              f.kind === "surface" ? `◌ ${f.mode}` :
              f.kind === "stitch" ? `⧉ ${f.bodies.length}${f.solid ? " → solid" : ""}` :
              f.kind === "thicken" ? `▤ ${f.thicknessExpr}` :
              f.kind === "trim" ? `✂ ${f.keep}` :
              f.kind === "untrim" ? "◍ fill" :
              f.kind === "hole" ? `⌀ ${f.diameterExpr}${f.at.length > 1 ? `×${f.at.length}` : ""}` :
              f.kind === "thread" ? `⇅ ${f.spec.form} ${f.spec.diameter}` :
              `${f.kind === "fillet" ? "r" : "d"}=${f.sizeExpr}`;
            return (
              <div className="dim-row" key={f.id} style={{ gridTemplateColumns: "18px 1fr 1fr 60px 22px" }}>
                {sol?.mesh ? <EyeToggle id={f.id} label={f.name} /> : <span />}
                <span className="dim-type" title={`${f.kind} ${f.id}`}>{f.name}</span>
                <span className="muted-inline">{detail}</span>
                <span className="dim-val" title={sol?.error ?? sol?.warning}>{sol?.error ? "⚠" : sol?.warning ? "!" : "✓"}</span>
                <button className="icon-btn danger" onClick={() => deleteFeature(f.id)}>✕</button>
              </div>
            );
          }
          return (
            <div className="dim-row" key={f.id} style={{ gridTemplateColumns: "18px 1fr 1fr 60px 22px" }}>
                {sol?.mesh ? <EyeToggle id={f.id} label={f.name} /> : <span />}
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
      <CutList />
      <FlatPatterns />
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
