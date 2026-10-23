import { useRef } from "react";
import { Tool, useStore } from "../model/store";
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

const TOOLS: { id: Tool; label: string; key: string; glyph: string }[] = [
  { id: "select", label: "Select", key: "S", glyph: "⤢" },
  { id: "line", label: "Line", key: "L", glyph: "╱" },
  { id: "rectangle", label: "Rectangle", key: "R", glyph: "▭" },
  { id: "circle", label: "Circle", key: "C", glyph: "◯" },
  { id: "arc", label: "Arc", key: "A", glyph: "◜" },
  { id: "point", label: "Point", key: "P", glyph: "•" },
];

export function Toolbar() {
  const mode = useStore((s) => s.mode);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const finishSketch = useStore((s) => s.finishSketch);
  const startSketch = useStore((s) => s.startSketch);
  const showPlanes = useStore((s) => s.showPlanes);
  const showGrid = useStore((s) => s.showGrid);
  const toggleShowPlanes = useStore((s) => s.toggleShowPlanes);
  const toggleShowGrid = useStore((s) => s.toggleShowGrid);
  const showConstraints = useStore((s) => s.showConstraints);
  const toggleShowConstraints = useStore((s) => s.toggleShowConstraints);
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const extrudeSketch = useStore((s) => s.extrudeSketch);
  const exportSolid = useStore((s) => s.exportSolid);
  const kernelLoading = useStore((s) => s.kernelLoading);
  const hasSolids = useStore((s) => Object.keys(s.solids).length > 0);

  const root = session.doc.components[session.doc.rootComponentId];
  const lastSketch = root?.sketches[root.sketches.length - 1];

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="logo">◆</span> Chisel<span className="brand-dim">CAD</span>
      </div>
      <FileMenu />

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
          <div className="spacer" />
          <label className="toggle" title="Show geometric constraint glyphs in the sketch">
            <input type="checkbox" checked={showConstraints} onChange={toggleShowConstraints} /> Constraints
          </label>
          <button className="btn primary" onClick={finishSketch}>
            ✓ Finish Sketch
          </button>
        </>
      ) : (
        <>
          <div className="tool-group">
            <span className="hint">New sketch:</span>
            {PLANES.map((p) => (
              <button
                key={p.id}
                className="tool"
                style={{ borderColor: p.color }}
                onClick={() => startSketch(p.id)}
                title={`Start a sketch on the ${p.name} plane`}
              >
                <span className="swatch" style={{ background: p.color }} />
                {p.id}
              </button>
            ))}
          </div>
          <div className="tool-group">
            <button
              className="btn"
              disabled={!lastSketch || kernelLoading}
              title={lastSketch ? "Extrude the most recent sketch into a solid" : "Create a sketch first"}
              onClick={() => lastSketch && extrudeSketch(lastSketch, "10")}
            >
              {kernelLoading ? "⏳ Loading 3D…" : "⬆ Extrude"}
            </button>
            {hasSolids && (
              <>
                <button className="btn" title="Export STEP (CAD/CNC)" onClick={() => exportSolid("step")}>⬇ STEP</button>
                <button className="btn" title="Export STL (3D print)" onClick={() => exportSolid("stl")}>⬇ STL</button>
              </>
            )}
          </div>
          <div className="spacer" />
          <label className="toggle">
            <input type="checkbox" checked={showPlanes} onChange={toggleShowPlanes} /> Planes
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showGrid} onChange={toggleShowGrid} /> Grid
          </label>
        </>
      )}
    </div>
  );
}
