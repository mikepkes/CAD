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

  const [offset, setOffset] = useState(0);
  const root = session.doc.components[session.doc.rootComponentId];
  const lastSketch = root?.sketches[root.sketches.length - 1];

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="logo">◆</span> Chisel<span className="brand-dim">CAD</span>
      </div>
      <FileMenu />
      <button className="btn ghost" title="Claude agent — sketch by describing it" onClick={() => useStore.getState().toggleAgent()}>✦ Agent</button>
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
                onClick={() => startSketch(p.id, offset || undefined)}
                title={`Start a sketch on the ${p.name} plane${offset ? ` (offset ${offset})` : ""} — or click a body face in the viewport`}
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
