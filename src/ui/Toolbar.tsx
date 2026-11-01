import { useEffect, useRef, useState } from "react";
import { Tool, TOOL_VARIANTS, useStore } from "../model/store";
import { PLANES } from "../geometry/plane";
import { ask } from "./kit/askDialog";
import { addPrimitive, addGear } from "./concepts/contextActions";
import { Icon, iconForAction } from "./icons";
import { ExamplesMenu } from "./ExamplesMenu";

function FileMenu() {
  const newDocument = useStore((s) => s.newDocument);
  const saveToFile = useStore((s) => s.saveToFile);
  const openFile = useStore((s) => s.openFile);
  const importFile = useStore((s) => s.importFile);
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  return (
    <div className="file-menu">
      <button className="btn ghost with-icon" title="New document" onClick={() => void ask({ title: "New document", text: "Start a new document? The current one is replaced; unsaved work is autosaved in this browser or app only.", confirmLabel: "New document", danger: true }).then((ok) => { if (ok) newDocument(); })}><Icon name="file-new" />New</button>
      <button className="btn ghost with-icon" title="Open a .vibecad.json file" onClick={() => inputRef.current?.click()}><Icon name="folder" />Open</button>
      <ExamplesMenu />
      <button className="btn ghost with-icon" title="Save to a .vibecad.json file" onClick={saveToFile}><Icon name="save" />Save</button>
      <button className="btn ghost with-icon" title="Import STEP, BREP, STL, FreeCAD (.FCStd) or Rhino (.3dm) as bodies" onClick={() => importRef.current?.click()}><Icon name="import" />Import</button>
      <ExportMenu />
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ""; }}
      />
      <input
        ref={importRef}
        type="file"
        accept=".step,.stp,.brep,.brp,.stl,.fcstd,.3dm,model/step,model/stl"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }}
      />
    </div>
  );
}

function GridControls() {
  const showGrid = useStore((s) => s.showGrid);
  const gridSize = useStore((s) => s.gridSize);
  const gridSnap = useStore((s) => s.gridSnap);
  return (
    <div className="grid-controls" title="Grid display, cell size (mm), and snapping">
      <label className="toggle">
        <input type="checkbox" checked={showGrid} onChange={() => useStore.getState().toggleShowGrid()} /> Grid
      </label>
      <input
        className="grid-size"
        type="number"
        min={0.1}
        step={1}
        value={gridSize}
        title="Grid cell size (mm)"
        onChange={(e) => { const n = Number(e.target.value); if (n > 0) useStore.getState().setGridSize(n); }}
      />
      <label className="toggle" title="Snap drawing to grid intersections">
        <input type="checkbox" checked={gridSnap} onChange={(e) => useStore.getState().setGridSnap(e.target.checked)} /> Snap
      </label>
    </div>
  );
}

function SectionControls() {
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);
  const hasSolids = useStore((s) => Object.keys(s.solids).length > 0);
  if (!hasSolids) return null;
  const on = !!section;
  const cur = section ?? { plane: "XY" as const, offset: 0, flip: false };
  return (
    <div className="grid-controls" title="Cross-section: clip the model on a plane to see inside">
      <label className="toggle">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setSection(e.target.checked ? cur : null)}
        /> Section
      </label>
      {on && (
        <>
          <select
            className="offset-input"
            value={cur.plane}
            title="Section plane"
            onChange={(e) => setSection({ ...cur, plane: e.target.value as "XY" | "XZ" | "YZ" })}
          >
            {PLANES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
          <input
            className="grid-size"
            type="number"
            step={1}
            value={cur.offset}
            title="Offset of the cut along the plane normal (mm)"
            onChange={(e) => setSection({ ...cur, offset: Number(e.target.value) || 0 })}
          />
          <button className="icon-btn" title="Flip which side is kept" aria-label="Flip which side is kept" onClick={() => setSection({ ...cur, flip: !cur.flip })}><Icon name="swap" size={14} /></button>
        </>
      )}
    </div>
  );
}

/** Surface-quality display: zebra / draft / curvature, and curvature combs. */
function AnalysisControls() {
  const a = useStore((s) => s.analysis);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const hasGeometry = useStore((s) => Object.keys(s.solids).length > 0 || s.mode === "sketch");
  if (!hasGeometry) return null;
  return (
    <div className="grid-controls" title="Surface quality: zebra stripes show continuity across edges (broken = crease, kinked = tangent only, smooth = curvature-continuous); draft colours faces against a pull direction; curvature maps it blue (concave) to red (convex)">
      <select className="offset-input" value={a.mode} title="Surface analysis" onChange={(e) => void setAnalysis({ mode: e.target.value as typeof a.mode })}>
        <option value="none">Shaded</option>
        <option value="zebra">Zebra</option>
        <option value="curvature">Curvature</option>
        <option value="draft">Draft</option>
      </select>
      {a.mode === "zebra" && (
        <input className="grid-size" type="number" min={2} max={60} step={1} value={a.stripes} title="Stripe count" onChange={(e) => void setAnalysis({ stripes: Number(e.target.value) || 12 })} />
      )}
      {a.mode === "curvature" && (
        <select className="offset-input" value={a.quantity} title="Which curvature to map" onChange={(e) => void setAnalysis({ quantity: e.target.value as typeof a.quantity })}>
          <option value="mean">Mean</option>
          <option value="gaussian">Gaussian</option>
          <option value="max">Max</option>
          <option value="min">Min</option>
        </select>
      )}
      {a.mode === "draft" && (
        <>
          <select className="offset-input" value={a.pull.x ? "X" : a.pull.y ? "Y" : "Z"} title="Pull direction" onChange={(e) => void setAnalysis({ pull: { x: e.target.value === "X" ? 1 : 0, y: e.target.value === "Y" ? 1 : 0, z: e.target.value === "Z" ? 1 : 0 } })}>
            <option value="Z">+Z</option><option value="Y">+Y</option><option value="X">+X</option>
          </select>
          <input className="grid-size" type="number" min={0} max={45} step={0.5} value={a.draftDeg} title="Minimum draft angle (°)" onChange={(e) => void setAnalysis({ draftDeg: Number(e.target.value) || 0 })} />
        </>
      )}
      <label className="toggle" title="Curvature combs on curved edges and sketch curves">
        <input type="checkbox" checked={a.combs} onChange={(e) => void setAnalysis({ combs: e.target.checked })} /> Combs
      </label>
    </div>
  );
}

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "S" },
  { id: "line", label: "Line", key: "L" },
  { id: "rectangle", label: "Rectangle", key: "R" },
  { id: "circle", label: "Circle", key: "C" },
  { id: "arc", label: "Arc", key: "A" },
  { id: "polygon", label: "Polygon", key: "G" },
  { id: "slot", label: "Slot", key: "O" },
  { id: "ellipse", label: "Ellipse", key: "I" },
  { id: "point", label: "Point", key: "P" },
  { id: "dimension", label: "Dimension", key: "D" },
  { id: "trim", label: "Trim", key: "T" },
  { id: "extend", label: "Extend", key: "E" },
];

export function Toolbar() {
  const mode = useStore((s) => s.mode);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const toolVariant = useStore((s) => s.toolVariant);
  const setToolVariant = useStore((s) => s.setToolVariant);
  const finishSketch = useStore((s) => s.finishSketch);
  const startSketch = useStore((s) => s.startSketch);
  const showPlanes = useStore((s) => s.showPlanes);
  const toggleShowPlanes = useStore((s) => s.toggleShowPlanes);
  const showConstraints = useStore((s) => s.showConstraints);
  const toggleShowConstraints = useStore((s) => s.toggleShowConstraints);
  const constructionMode = useStore((s) => s.constructionMode);
  const hasSelection = useStore((s) => s.selection.length > 0);
  const sketchPlacing = useStore((s) => s.sketchPlacing);
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const kernelLoading = useStore((s) => s.kernelLoading);
  const hasSolids = useStore((s) => Object.keys(s.solids).length > 0);

  const [offset, setOffset] = useState(0);
  const [datumBase, setDatumBase] = useState("XY");
  const [mirrorPlane, setMirrorPlane] = useState("YZ");
  const createDatumPlane = useStore((s) => s.createDatumPlane);
  const mirrorModel = useStore((s) => s.mirrorModel);
  const activeComponentId = useStore((s) => s.activeComponentId);
  const activateComponent = useStore((s) => s.activateComponent);
  const datumPlanes = Object.values(session.doc.planes);
  const root = session.doc.components[session.doc.rootComponentId];
  const lastSketch = root?.sketches[root.sketches.length - 1];

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="logo">◆</span> Vibe<span className="brand-dim">CAD</span>
      </div>
      <FileMenu />
      <button className="btn ghost with-icon" title="Claude agent — sketch by describing it" onClick={() => useStore.getState().toggleAgent()}><Icon name="agent" />Agent</button>
      <button className="btn ghost with-icon" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => useStore.getState().setHotkeysOpen(true)}><Icon name="keyboard" /></button>
      <button className="btn ghost with-icon" title="Settings" aria-label="Settings" onClick={() => useStore.getState().setSettingsOpen(true)}><Icon name="settings" /></button>

      {mode === "sketch" ? (
        <>
          <div className="tool-group">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool ${tool === t.id ? "active" : ""}`}
                title={`${t.label} (${t.key})`}
                onClick={() => setTool(t.id)}
              >
                <Icon name={iconForAction(`tool.${t.id}`)} />
                <span className="tool-label">{t.label}</span>
              </button>
            ))}
          </div>
          {TOOL_VARIANTS[tool] && (
            <div className="variant-group" title={`${tool} style`}>
              {TOOL_VARIANTS[tool]!.map((v) => (
                <button
                  key={v.id}
                  className={`variant-chip ${toolVariant === v.id ? "active" : ""}`}
                  onClick={() => setToolVariant(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <button
            className={`tool construction-toggle ${constructionMode ? "active" : ""}`}
            title={
              hasSelection
                ? "Convert the selected geometry to/from construction (reference)"
                : "Construction mode (X): new geometry becomes reference — dashed, excluded from filled profiles"
            }
            onClick={() => useStore.getState().toggleConstruction()}
          >
            <Icon name="construction" />
            <span className="tool-label">{hasSelection ? "Construction" : constructionMode ? "Construction ✓" : "Construction"}</span>
          </button>
          <div className="spacer" />
          <button
            className="btn ghost with-icon"
            title="Project existing body edges onto this sketch plane"
            onClick={() => useStore.getState().projectBodies(false)}
          >
            <Icon name="project" />Project
          </button>
          <button
            className="btn ghost with-icon"
            title="Look at the sketch plane (orient normal-to)"
            onClick={() => window.dispatchEvent(new CustomEvent("vibecad:lookAt"))}
          >
            <Icon name="look-at" />Look At
          </button>
          <label className="toggle" title="Show geometric constraint glyphs in the sketch">
            <input type="checkbox" checked={showConstraints} onChange={toggleShowConstraints} /> Constraints
          </label>
          <GridControls />
          <button className="btn primary with-icon" onClick={finishSketch}>
            <Icon name="check" />Finish Sketch
          </button>
        </>
      ) : (
        <>
          <button
            className={`btn with-icon ${sketchPlacing ? "primary" : ""}`}
            title="Create Sketch — then click a plane or a planar face (or pick a plane below)"
            onClick={() => useStore.getState().setSketchPlacing(!sketchPlacing)}
          >
            <Icon name="sketch" />Create Sketch
          </button>
          <button
            className="btn with-icon"
            title="Create a sub-component under the active one and activate it (new sketches land there)"
            onClick={() => useStore.getState().createComponent()}
          >
            <Icon name="component-add" />Component
          </button>
          {activeComponentId !== session.doc.rootComponentId && (
            <span className="hint" title="Active component — new sketches are scoped here" style={{ color: "var(--ic-joint)" }}>
              ⬡ {session.doc.components[activeComponentId]?.name}
              <button className="icon-btn" title="Back to root component" onClick={() => activateComponent(session.doc.rootComponentId)}>✕</button>
            </span>
          )}
          <div className="tool-group">
            <span className="hint">{sketchPlacing ? "Pick a plane or face:" : "On plane:"}</span>
            {PLANES.map((p) => (
              <button
                key={p.id}
                className="tool"
                style={{ borderColor: p.color }}
                onClick={() => startSketch(p.id, offset || undefined)}
                title={`Start a sketch on the ${p.name} plane${offset ? ` (offset ${offset})` : ""}`}
              >
                <span className="swatch" style={{ background: p.color }} />
                {p.id}
              </button>
            ))}
            <input
              className="offset-input"
              type="number"
              value={offset}
              title="Offset distance along the plane normal (0 = on the plane)"
              onChange={(e) => setOffset(Number(e.target.value) || 0)}
              placeholder="offset"
            />
          </div>
          <div className="tool-group">
            <span className="hint">Datum:</span>
            <select
              className="offset-input"
              value={datumBase}
              title="Base plane for a new offset (datum) plane"
              onChange={(e) => setDatumBase(e.target.value)}
            >
              {PLANES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              {datumPlanes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button
              className="tool"
              title={`Create a reusable offset plane ${offset} from ${datumBase} (parametric; editable in the timeline)`}
              onClick={() => createDatumPlane(datumBase, String(offset))}
            >
              <Icon name="plane-offset" />Offset Plane
            </button>
            {datumPlanes.map((d) => (
              <button
                key={d.id}
                className="tool"
                style={{ borderColor: "var(--ic-datum)" }}
                onClick={() => startSketch(d.id)}
                title={`Start a sketch on ${d.name}${d.error ? ` (unresolved: ${d.error})` : ""}`}
              >
                <span className="swatch" style={{ background: "var(--ic-datum)" }} />
                {d.name}
              </button>
            ))}
          </div>
          <div className="tool-group">
            <button className="btn with-icon" disabled={kernelLoading} title="Add a box (B): click a face to push and pull it to size" onClick={() => void addPrimitive("box")}><Icon name="box" />Box</button>
            <button className="btn with-icon" disabled={kernelLoading} title="Add a cylinder: click its end or side to push and pull it" onClick={() => void addPrimitive("cylinder")}><Icon name="cylinder" />Cylinder</button>
            <button className="btn with-icon" disabled={kernelLoading} title="Add a gear (G): spur, helical, herringbone, ring, rack, bevel or worm — its card sets the type, teeth and sizes" onClick={() => void addGear()}><Icon name="gear" />Gear</button>
            <button
              className="btn with-icon"
              disabled={!lastSketch || kernelLoading}
              title={lastSketch ? "Extrude a sketch region into a solid (new / join / cut)" : "Create a sketch first"}
              onClick={() => useStore.getState().openExtrude()}
            >
              {kernelLoading ? "⏳ Loading 3D…" : <><Icon name="extrude" />Extrude</>}
            </button>
            {hasSolids && (
              <>
                <select
                  className="offset-input"
                  value={mirrorPlane}
                  title="Plane to mirror the model across"
                  onChange={(e) => setMirrorPlane(e.target.value)}
                >
                  {PLANES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                  {datumPlanes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <button className="btn with-icon" title="Mirror the model across the chosen plane (symmetry)" onClick={() => mirrorModel(mirrorPlane)}>
                  <Icon name="mirror" />Mirror
                </button>
              </>
            )}
          </div>
          <div className="spacer" />
          <label className="toggle">
            <input type="checkbox" checked={showPlanes} onChange={toggleShowPlanes} /> Planes
          </label>
          <GridControls />
          <SectionControls />
          <AnalysisControls />
        </>
      )}
    </div>
  );
}

/** Every output in one menu: the model's files (STEP, STL, 3MF) and the shop drawing. */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const hasSolids = useStore((s) => Object.values(s.solids).some((b) => b.mesh));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const S = useStore.getState;
  const items: { label: string; note: string; run: () => void }[] = [
    { label: "STEP", note: "for other CAD tools and CNC", run: () => void S().exportSolid("step") },
    { label: "STL", note: "for any 3D printer", run: () => void S().exportSolid("stl") },
    { label: "3MF", note: "one print, a part per material", run: () => void S().exportSolid("3mf") },
    { label: "Shop drawing", note: "views, dimensions and the cut list", run: () => void S().openDrawing() },
  ];
  return (
    <span className="export-menu">
      <button className="btn ghost with-icon" aria-haspopup="menu" aria-expanded={open} title="Export the model or make a shop drawing" onClick={() => setOpen((o) => !o)}><Icon name="export" />Export ▾</button>
      {open && (
        <>
          <div className="export-scrim" onPointerDown={() => setOpen(false)} />
          <div className="export-list" role="menu" aria-label="Export">
            {items.map((it) => (
              <button key={it.label} role="menuitem" className="export-item" disabled={!hasSolids} onClick={() => { setOpen(false); it.run(); }}>
                <b>{it.label}</b><span>{it.note}</span>
              </button>
            ))}
            {!hasSolids && <div className="export-empty">Make a body first.</div>}
          </div>
        </>
      )}
    </span>
  );
}
