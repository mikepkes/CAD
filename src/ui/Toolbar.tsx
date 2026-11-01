import { ReactNode, useEffect, useRef, useState } from "react";
import { Tool, TOOL_VARIANTS, useStore } from "../model/store";
import { PLANES } from "../geometry/plane";
import { ask } from "./kit/askDialog";
import { addPrimitive, addGear } from "./concepts/contextActions";
import { Icon, iconForAction } from "./icons";
import { OverflowRow, type OverflowRowItem } from "./kit/OverflowRow";
import { driveParams } from "../model/motionStudy";
import { ExamplesMenu } from "./ExamplesMenu";

/** Open a file in place of the current document, asking first (as New does) when there is something to lose. */
export async function confirmOpen(file: File): Promise<void> {
  const st = useStore.getState();
  if (st.session.doc.operations.length) {
    const ok = await ask({
      title: `Open ${file.name}?`,
      text: st.dirty
        ? "It replaces the current document, which has changes not saved to a file. Save first (⌘S) to keep them."
        : "It replaces the current document (saved, and autosaved in this browser or app).",
      confirmLabel: "Open", danger: st.dirty,
    });
    if (!ok) return;
  }
  await useStore.getState().openFile(file);
}

/** The document's name (Save names the file after it) and a dot while it has unsaved changes. */
function DocName() {
  const name = useStore((s) => s.session.doc.name);
  const dirty = useStore((s) => s.dirty);
  useStore((s) => s.rev);
  const commit = (el: HTMLInputElement) => { if (el.value.trim() !== (name ?? "")) void useStore.getState().renameDocument(el.value); };
  return (
    <span className="doc-name">
      <input
        aria-label="Document name"
        placeholder="Untitled"
        title="The document's name: Save names the file after it"
        defaultValue={name ?? ""}
        key={name ?? ""}
        spellCheck={false}
        onBlur={(e) => commit(e.target)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") { (e.target as HTMLInputElement).value = name ?? ""; (e.target as HTMLInputElement).blur(); }
        }}
      />
      {dirty && <span className="dirty-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes: Save (⌘S) keeps them in a file" />}
    </span>
  );
}

const OPEN_INPUT = "vibecad-open-input", IMPORT_INPUT = "vibecad-import-input";
const pick = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.click();

/** The file pickers Open and Import use: mounted once, outside the row, so a button in the ⋯ menu still reaches them. */
function FileInputs() {
  const importFile = useStore((s) => s.importFile);
  return (
    <>
      <input id={OPEN_INPUT} type="file" accept=".json,application/json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void confirmOpen(f); e.target.value = ""; }} />
      <input id={IMPORT_INPUT} type="file" accept=".step,.stp,.brep,.brp,.stl,.fcstd,.3dm,model/step,model/stl" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />
    </>
  );
}

/** New, Open, Save, Import and Export, each its own item so the least used go into ⋯ first. */
function fileItems(): OverflowRowItem[] {
  const S = useStore.getState;
  return [
    { key: "docname", priority: 7, node: <DocName /> },
    { key: "new", priority: 5, node: <button className="btn ghost with-icon" title="New document" onClick={() => void ask({ title: "New document", text: "Start a new document? The current one is replaced; unsaved work is autosaved in this browser or app only.", confirmLabel: "New document", danger: true }).then((ok) => { if (ok) S().newDocument(); })}><Icon name="file-new" />New</button> },
    { key: "open", priority: 3, node: <button className="btn ghost with-icon" title="Open a .vibecad.json file" onClick={() => pick(OPEN_INPUT)}><Icon name="folder" />Open</button> },
    { key: "examples", priority: 3, node: <ExamplesMenu /> },
    { key: "save", priority: 6, node: <button className="btn ghost with-icon" title="Save to a .vibecad.json file named after the document (⌘S)" onClick={() => S().saveToFile()}><Icon name="save" />Save</button> },
    { key: "import", priority: 2, node: <button className="btn ghost with-icon" title="Import STEP, BREP, STL, FreeCAD (.FCStd) or Rhino (.3dm) as bodies" onClick={() => pick(IMPORT_INPUT)}><Icon name="import" />Import</button> },
    { key: "export", priority: 6, node: <span className="file-menu"><ExportMenu /></span> },
  ];
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
            aria-label="Section offset (mm)"
            title="Offset of the cut along the plane normal (mm)"
            onChange={(e) => setSection({ ...cur, offset: Number(e.target.value) || 0 })}
          />
          <button className="icon-btn" title="Flip which side is kept" aria-label="Flip which side is kept" onClick={() => setSection({ ...cur, flip: !cur.flip })}><Icon name="swap" size={14} /></button>
        </>
      )}
    </div>
  );
}

/** Curvature combs on sketch curves (the Lens owns the model's analysis views and their settings). */
function CombsToggle() {
  const combs = useStore((s) => s.analysis.combs);
  return (
    <label className="toggle" title="Curvature combs on the sketch's curves (and the model's curved edges)">
      <input type="checkbox" checked={combs} onChange={(e) => void useStore.getState().setAnalysis({ combs: e.target.checked })} /> Combs
    </label>
  );
}

/** A button that opens a small panel under it (the datum planes); closes on a click outside or Escape. */
function Popover(p: { label: ReactNode; title: string; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <span ref={ref} className={`tb-pop-wrap${p.className ? ` ${p.className}` : ""}`}>
      <button className="btn with-icon" aria-haspopup="dialog" aria-expanded={open} title={p.title} onClick={() => setOpen((o) => !o)}>{p.label}</button>
      {open && <div className="tb-pop" role="dialog" aria-label={p.title}>{p.children(() => setOpen(false))}</div>}
    </span>
  );
}

/** The datum planes in one dropdown: sketch on one, or add an offset plane (from a base plane, by a distance). */
function DatumMenu() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const [base, setBase] = useState("XY");
  const [dist, setDist] = useState(10);
  const datumPlanes = Object.values(session.doc.planes);
  const st = useStore.getState;
  return (
    <Popover title="Datum planes: sketch on one, or add an offset plane" label={<><Icon name="plane-offset" />Datum{datumPlanes.length ? <span className="tb-count">{datumPlanes.length}</span> : null} ▾</>}>
      {(close) => (
        <>
          <div className="tb-pop-head">Sketch on a datum plane</div>
          {datumPlanes.length === 0 && <div className="tb-pop-empty">No datum planes yet.</div>}
          <div className="tb-pop-list">
            {datumPlanes.map((d) => (
              <button key={d.id} className="tb-pop-item" title={`Start a sketch on ${d.name}${d.error ? ` (unresolved: ${d.error})` : ""}`} onClick={() => { close(); st().startSketch(d.id); }}>
                <span className="swatch" style={{ background: "var(--ic-datum)" }} />{d.name}
              </button>
            ))}
          </div>
          <div className="tb-pop-head">New offset plane</div>
          <div className="tb-pop-row">
            <label className="tb-field"><span>From</span>
              <select className="offset-input" value={base} aria-label="Base plane for the new offset plane" onChange={(e) => setBase(e.target.value)}>
                {PLANES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                {datumPlanes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="tb-field"><span>Offset</span>
              <input className="offset-input" type="number" value={dist} aria-label="Offset of the new plane (mm)" onChange={(e) => setDist(Number(e.target.value) || 0)} /><span className="tb-unit">mm</span>
            </label>
            <button className="tool" title={`Create a reusable plane ${dist} mm from ${base} (parametric; editable in the timeline)`} onClick={() => { close(); void st().createDatumPlane(base, String(dist)); }}>
              <Icon name="plane-offset" />Add plane
            </button>
          </div>
        </>
      )}
    </Popover>
  );
}

/** The motion study (does the mechanism move through its range without parts colliding?), in the editor too. */
function MotionButton() {
  const has = useStore((s) => driveParams(s.session.doc).length > 0);
  const status = useStore((s) => s.motionStatus);
  const progress = useStore((s) => s.motionProgress);
  if (!has) return null;
  const running = status === "running";
  return (
    <button className={`btn with-icon${running ? " primary" : ""}`} title="Motion study: drive the joints through their range and check that no parts collide"
      onClick={() => (running ? useStore.getState().cancelMotionStudy() : void useStore.getState().runMotionStudy())}>
      <Icon name="play" />{running ? `Motion ${Math.round(progress * 100)}%` : "Motion"}
    </button>
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
  const [mirrorPlane, setMirrorPlane] = useState("YZ");
  const mirrorModel = useStore((s) => s.mirrorModel);
  const activeComponentId = useStore((s) => s.activeComponentId);
  const activateComponent = useStore((s) => s.activateComponent);
  const datumPlanes = Object.values(session.doc.planes);
  const root = session.doc.components[session.doc.rootComponentId];
  const lastSketch = root?.sketches[root.sketches.length - 1];

  // Every control is an item of one fixed-height row; what doesn't fit goes, lowest priority first, into ⋯.
  const common: OverflowRowItem[] = [
    { key: "brand", pin: true, node: <div className="brand"><span className="logo">◆</span> Vibe<span className="brand-dim">CAD</span></div> },
    ...fileItems(),
  ];
  // the agent, the shortcuts and the settings close the row, by the ⋯
  const tail: OverflowRowItem[] = [
    { key: "agent", priority: 5, node: <button className="btn ghost with-icon" title="Claude agent — sketch by describing it" onClick={() => useStore.getState().toggleAgent()}><Icon name="agent" />Agent</button> },
    { key: "keys", priority: 5, node: <button className="btn ghost with-icon" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => useStore.getState().setHotkeysOpen(true)}><Icon name="keyboard" /></button>,
      menuNode: <button className="btn ghost with-icon" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => useStore.getState().setHotkeysOpen(true)}><Icon name="keyboard" />Shortcuts</button> },
    { key: "settings", priority: 4, node: <button className="btn ghost with-icon" title="Settings" aria-label="Settings" onClick={() => useStore.getState().setSettingsOpen(true)}><Icon name="settings" /></button>,
      menuNode: <button className="btn ghost with-icon" title="Settings" aria-label="Settings" onClick={() => useStore.getState().setSettingsOpen(true)}><Icon name="settings" />Settings</button> },
  ];

  const sketchItems: OverflowRowItem[] = [
    ...TOOLS.map((t): OverflowRowItem => ({
      key: `tool-${t.id}`,
      priority: ["select", "line", "rectangle", "circle", "arc", "dimension"].includes(t.id) ? 8 : 6,
      node: (
        <button className={`tool ${tool === t.id ? "active" : ""}`} title={`${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
          <Icon name={iconForAction(`tool.${t.id}`)} />
          <span className="tool-label">{t.label}</span>
        </button>
      ),
    })),
    ...(TOOL_VARIANTS[tool] ? [{
      key: "variants", priority: 7,
      node: (
        <div className="variant-group" title={`${tool} style`}>
          {TOOL_VARIANTS[tool]!.map((v) => (
            <button key={v.id} className={`variant-chip ${toolVariant === v.id ? "active" : ""}`} onClick={() => setToolVariant(v.id)}>{v.label}</button>
          ))}
        </div>
      ),
    }] : []),
    { key: "construction", priority: 7, node: (
      <button
        className={`tool construction-toggle ${constructionMode ? "active" : ""}`}
        title={hasSelection ? "Convert the selected geometry to/from construction (reference)" : "Construction mode (X): new geometry becomes reference — dashed, excluded from filled profiles"}
        onClick={() => useStore.getState().toggleConstruction()}
      >
        <Icon name="construction" />
        <span className="tool-label">{hasSelection ? "Construction" : constructionMode ? "Construction ✓" : "Construction"}</span>
      </button>
    ) },
    { key: "spacer", spacer: true, node: null },
    { key: "project", priority: 3, node: <button className="btn ghost with-icon" title="Project existing body edges onto this sketch plane" onClick={() => useStore.getState().projectBodies(false)}><Icon name="project" />Project</button> },
    { key: "lookAt", priority: 3, node: <button className="btn ghost with-icon" title="Look at the sketch plane (orient normal-to)" onClick={() => window.dispatchEvent(new CustomEvent("vibecad:lookAt"))}><Icon name="look-at" />Look At</button> },
    { key: "constraints", priority: 2, node: <label className="toggle" title="Show geometric constraint glyphs in the sketch"><input type="checkbox" checked={showConstraints} onChange={toggleShowConstraints} /> Constraints</label> },
    { key: "grid", priority: 1, node: <GridControls /> },
    { key: "combs", priority: 1, node: <CombsToggle /> },
    { key: "finish", pin: true, node: <button className="btn primary with-icon" onClick={finishSketch}><Icon name="check" />Finish Sketch</button> },
  ];

  const modelItems: OverflowRowItem[] = [
    { key: "sketch", priority: 9, node: (
      <button className={`btn with-icon ${sketchPlacing ? "primary" : ""}`} title="Create Sketch — then click a plane or a planar face (or pick a plane below)" onClick={() => useStore.getState().setSketchPlacing(!sketchPlacing)}>
        <Icon name="sketch" />Create Sketch
      </button>
    ) },
    { key: "component", priority: 4, node: (
      <button className="btn with-icon" title="Create a sub-component under the active one and activate it (new sketches land there)" onClick={() => useStore.getState().createComponent()}>
        <Icon name="component-add" />Component
      </button>
    ) },
    ...(activeComponentId !== session.doc.rootComponentId ? [{ key: "active", priority: 6, node: (
      <span className="hint tb-active" title="Active component — new sketches are scoped here" style={{ color: "var(--ic-joint)" }}>
        ⬡ {session.doc.components[activeComponentId]?.name}
        <button className="icon-btn" title="Back to root component" aria-label="Back to the root component" onClick={() => activateComponent(session.doc.rootComponentId)}>✕</button>
      </span>
    ) }] : []),
    { key: "planes", priority: 6, node: (
      <div className="tool-group">
        <span className="hint">{sketchPlacing ? "Pick a plane or face:" : "Sketch on"}</span>
        {PLANES.map((p) => (
          <button key={p.id} className="tool" style={{ borderColor: p.color }} onClick={() => startSketch(p.id, offset || undefined)} title={`Start a sketch on the ${p.name} plane${offset ? ` (offset ${offset} mm)` : ""}`}>
            <span className="swatch" style={{ background: p.color }} />
            {p.id}
          </button>
        ))}
        <label className="tb-field" title="Start the sketch this far along the plane's normal (0 = on the plane)">
          <span>Offset</span>
          <input className="offset-input" type="number" value={offset} aria-label="Sketch offset from the plane (mm)" onChange={(e) => setOffset(Number(e.target.value) || 0)} />
        </label>
      </div>
    ) },
    { key: "datum", priority: 4, node: <DatumMenu /> },
    { key: "box", priority: 7, node: <button className="btn with-icon" disabled={kernelLoading} title="Add a box (B): click a face to push and pull it to size" onClick={() => void addPrimitive("box")}><Icon name="box" />Box</button> },
    { key: "cylinder", priority: 6, node: <button className="btn with-icon" disabled={kernelLoading} title="Add a cylinder: click its end or side to push and pull it" onClick={() => void addPrimitive("cylinder")}><Icon name="cylinder" />Cylinder</button> },
    { key: "gear", priority: 5, node: <button className="btn with-icon" disabled={kernelLoading} title="Add a gear (G): spur, helical, herringbone, ring, rack, bevel or worm — its card sets the type, teeth and sizes" onClick={() => void addGear()}><Icon name="gear" />Gear</button> },
    { key: "extrude", priority: 8, node: (
      <button className="btn with-icon" disabled={!lastSketch || kernelLoading} title={lastSketch ? "Extrude a sketch region into a solid (new / join / cut)" : "Create a sketch first"} onClick={() => useStore.getState().openExtrude()}>
        {kernelLoading ? "⏳ Loading 3D…" : <><Icon name="extrude" />Extrude</>}
      </button>
    ) },
    { key: "revolve", priority: 6, node: (
      <button className="btn with-icon" disabled={!lastSketch || kernelLoading} title={lastSketch ? "Revolve a sketch profile about a line or an axis" : "Create a sketch first"} onClick={() => useStore.getState().openFeatureTool("revolve")}>
        <Icon name="revolve" />Revolve
      </button>
    ) },
    { key: "modify", priority: 5, node: <ModifyMenu disabled={!hasSolids || kernelLoading} /> },
    ...(hasSolids ? [{ key: "mirror", priority: 3, node: (
      <div className="tool-group">
        <label className="tb-field" title="The plane the model is mirrored across">
          <span>Mirror about</span>
          <select className="offset-input" value={mirrorPlane} aria-label="Mirror plane" onChange={(e) => setMirrorPlane(e.target.value)}>
            {PLANES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
            {datumPlanes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <button className="btn with-icon" title={`Mirror the model across ${mirrorPlane} (symmetry)`} onClick={() => mirrorModel(mirrorPlane)}>
          <Icon name="mirror" />Mirror
        </button>
      </div>
    ) }] : []),
    { key: "motion", priority: 4, node: <MotionButton /> },
    { key: "spacer", spacer: true, node: null },
    { key: "planesToggle", priority: 2, node: <label className="toggle" title="Show the origin and datum planes"><input type="checkbox" checked={showPlanes} onChange={toggleShowPlanes} /> Planes</label> },
    { key: "grid", priority: 1, node: <GridControls /> },
    { key: "section", priority: 5, node: <SectionControls /> },
  ];

  return (
    <>
      <OverflowRow className="toolbar" role="toolbar" ariaLabel="Toolbar" moreLabel="More tools" items={[...common, ...(mode === "sketch" ? sketchItems : modelItems), ...tail]} />
      <FileInputs />
    </>
  );
}

/** The modelling tools that change a body: fillet or chamfer picked edges, shell, pattern. */
function ModifyMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const S = useStore.getState;
  const items: { label: string; note: string; icon: Parameters<typeof Icon>[0]["name"]; run: () => void }[] = [
    { label: "Fillet edges", note: "round the edges you click", icon: "fillet", run: () => S().openFeatureTool("edges", "fillet") },
    { label: "Chamfer edges", note: "bevel the edges you click", icon: "chamfer", run: () => S().openFeatureTool("edges", "chamfer") },
    { label: "Shell", note: "hollow a body, opening faces", icon: "shell", run: () => S().openFeatureTool("shell") },
    { label: "Pattern", note: "copies along a line or around an axis", icon: "pattern-linear", run: () => S().openFeatureTool("pattern") },
  ];
  return (
    <span className="export-menu">
      <button className="btn with-icon" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={disabled ? "Make a body first" : "Fillet, chamfer, shell or pattern a body"} onClick={() => setOpen((o) => !o)}><Icon name="fillet" />Modify ▾</button>
      {open && (
        <>
          <div className="export-scrim" onPointerDown={() => setOpen(false)} />
          <div className="export-list" role="menu" aria-label="Modify">
            {items.map((it) => (
              <button key={it.label} role="menuitem" className="export-item" onClick={() => { setOpen(false); it.run(); }}>
                <b>{it.label}</b><span>{it.note}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
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
