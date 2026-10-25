import { useRef, useState } from "react";
import { Tool, TOOL_VARIANTS, useStore } from "../model/store";
import { PLANES } from "../geometry/plane";

function FileMenu() {
  const newDocument = useStore((s) => s.newDocument);
  const saveToFile = useStore((s) => s.saveToFile);
  const openFile = useStore((s) => s.openFile);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="file-menu">
      <button className="btn ghost" title="New document" onClick={() => { if (confirm("Start a new document? Unsaved work is autosaved in this browser only.")) newDocument(); }}>New</button>
      <button className="btn ghost" title="Open a .chisel.json file" onClick={() => inputRef.current?.click()}>Open</button>
      <button className="btn ghost" title="Save to a .chisel.json file" onClick={saveToFile}>Save</button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ""; }}
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
          <button className="icon-btn" title="Flip which side is kept" onClick={() => setSection({ ...cur, flip: !cur.flip })}>⇄</button>
        </>
      )}
    </div>
  );
}

const TOOLS: { id: Tool; label: string; key: string; glyph: string }[] = [
  { id: "select", label: "Select", key: "S", glyph: "⤢" },
  { id: "line", label: "Line", key: "L", glyph: "╱" },
  { id: "rectangle", label: "Rectangle", key: "R", glyph: "▭" },
  { id: "circle", label: "Circle", key: "C", glyph: "◯" },
  { id: "arc", label: "Arc", key: "A", glyph: "◜" },
  { id: "polygon", label: "Polygon", key: "G", glyph: "⬡" },
  { id: "slot", label: "Slot", key: "O", glyph: "⬭" },
  { id: "ellipse", label: "Ellipse", key: "I", glyph: "⬯" },
  { id: "point", label: "Point", key: "P", glyph: "•" },
  { id: "dimension", label: "Dimension", key: "D", glyph: "↦" },
  { id: "trim", label: "Trim", key: "T", glyph: "✂" },
  { id: "extend", label: "Extend", key: "E", glyph: "⇥" },
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
  const exportSolid = useStore((s) => s.exportSolid);
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
        <span className="logo">◆</span> Chisel<span className="brand-dim">CAD</span>
      </div>
      <FileMenu />
      <button className="btn ghost" title="Claude agent — sketch by describing it" onClick={() => useStore.getState().toggleAgent()}>✦ Agent</button>
      <button className="btn ghost" title="Keyboard shortcuts" onClick={() => useStore.getState().setHotkeysOpen(true)}>⌨</button>
      <button className="btn ghost" title="Settings" onClick={() => useStore.getState().setSettingsOpen(true)}>⚙</button>

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
                <span className="tool-glyph">{t.glyph}</span>
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
            <span className="tool-glyph">┄</span>
            <span className="tool-label">{hasSelection ? "Construction" : constructionMode ? "Construction ✓" : "Construction"}</span>
          </button>
          <div className="spacer" />
          <button
            className="btn ghost"
            title="Project existing body edges onto this sketch plane"
            onClick={() => useStore.getState().projectBodies(false)}
          >
            ⧉ Project
          </button>
          <button
            className="btn ghost"
            title="Look at the sketch plane (orient normal-to)"
            onClick={() => window.dispatchEvent(new CustomEvent("chisel:lookAt"))}
          >
            ⟂ Look At
          </button>
          <label className="toggle" title="Show geometric constraint glyphs in the sketch">
            <input type="checkbox" checked={showConstraints} onChange={toggleShowConstraints} /> Constraints
          </label>
          <GridControls />
          <button className="btn primary" onClick={finishSketch}>
            ✓ Finish Sketch
          </button>
        </>
      ) : (
        <>
          <button
            className={`btn ${sketchPlacing ? "primary" : ""}`}
            title="Create Sketch — then click a plane or a planar face (or pick a plane below)"
            onClick={() => useStore.getState().setSketchPlacing(!sketchPlacing)}
          >
            ✏ Create Sketch
          </button>
          <button
            className="btn"
            title="Create a sub-component under the active one and activate it (new sketches land there)"
            onClick={() => useStore.getState().createComponent()}
          >
            ⬡ Component
          </button>
          {activeComponentId !== session.doc.rootComponentId && (
            <span className="hint" title="Active component — new sketches are scoped here" style={{ color: "#8fd3ff" }}>
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
              ＋ Offset Plane
            </button>
            {datumPlanes.map((d) => (
              <button
                key={d.id}
                className="tool"
                style={{ borderColor: "#c9a227" }}
                onClick={() => startSketch(d.id)}
                title={`Start a sketch on ${d.name}${d.error ? ` (unresolved: ${d.error})` : ""}`}
              >
                <span className="swatch" style={{ background: "#c9a227" }} />
                {d.name}
              </button>
            ))}
          </div>
          <div className="tool-group">
            <button
              className="btn"
              disabled={!lastSketch || kernelLoading}
              title={lastSketch ? "Extrude a sketch region into a solid (new / join / cut)" : "Create a sketch first"}
              onClick={() => useStore.getState().openExtrude()}
            >
              {kernelLoading ? "⏳ Loading 3D…" : "⬆ Extrude"}
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
                <button className="btn" title="Mirror the model across the chosen plane (symmetry)" onClick={() => mirrorModel(mirrorPlane)}>
                  ⟷ Mirror
                </button>
                <button className="btn" title="Export STEP (CAD/CNC)" onClick={() => exportSolid("step")}>⬇ STEP</button>
                <button className="btn" title="Export STL (3D print)" onClick={() => exportSolid("stl")}>⬇ STL</button>
              </>
            )}
          </div>
          <div className="spacer" />
          <label className="toggle">
            <input type="checkbox" checked={showPlanes} onChange={toggleShowPlanes} /> Planes
          </label>
          <GridControls />
          <SectionControls />
        </>
      )}
    </div>
  );
}
