# Chisel CAD

**Live demo: https://mikepkes.github.io/CAD/**

**Try the parametric customize mode** (slider-only product tuning, with a live
pass/fail motion study):
**https://mikepkes.github.io/CAD/?mode=customize&example=gyroscope** — drag the
sliders to resize the print-in-place gyroscope gimbal; after a short dwell it
sweeps both rings through a full turn and tells you whether the chosen
dimensions still rotate freely or jam.

A **local-first, browser-based parametric CAD** app. It runs entirely in the
browser (static, GitHub-Pages-servable) and is built so the geometry is
**math-exact and CNC/3D-print ready**, not just a pretty picture. The long-term
goal is a Fusion 360–style modeler with components and 3D solids on an
**OpenCASCADE** kernel; this milestone makes **2D constraint sketching**
excellent and lays the command/history/solver foundation everything else builds
on.

## What works today

- **3D viewport** (three.js, Z-up) with the three origin planes, grid, axes,
  orbit/pan/zoom (mouse + touch). The renderer is an *adapter* — the core is
  renderer-agnostic.
- **Sketch on any origin plane**; draw with line / rectangle / circle / arc /
  **polygon** / point. **Constraint inference while drawing** (coincident,
  horizontal/vertical, parallel, perpendicular, on-curve, midpoint) with
  on-screen glyphs and rich snapping (endpoint, center, midpoint, on-curve).
- **Geometric + dimensional constraints**, every dimension a **parametric
  expression** over named parameters (`width`, `width/2`, `rad(30)`). Modal
  **Dimension tool** with in-canvas value entry and double-click-to-edit;
  **driven (reference)** dimensions that measure without constraining.
  Constraints include collinear, equal, concentric, symmetric, point-on-line /
  -circle, midpoint, fix.
- **Editing tools:** Trim, Extend, Offset, corner **Fillet / Chamfer**, Mirror,
  Linear / Grid / Circular patterns — backed by a curve–curve intersection
  module.
- **Selection & UX:** window/crossing box-select, right-click context menu,
  a **Construction** toggle (draw reference geometry, or convert a selection —
  dashed, excluded from filled profiles), Look At (normal-to-plane), a
  selection-aware constraint/dimension/modify bar.
- **Hotkey manager** (⌨): commands register themselves in a *context*; contexts
  stack (sketch on top of global) and resolve top-down, so one key can mean
  different things per context (e.g. `F` = frame selection globally, Look At
  while sketching). Primary + secondary bindings, rebind in the UI, per-context
  conflict detection; bindings persist in the browser and are readable/settable
  over the agent and WebMCP (`get_hotkeys` / `set_hotkey`).
- **PlaneGCS** (FreeCAD's constraint solver, via WebAssembly) solves the sketch
  and reports **degrees of freedom**, a **fully-constrained** state, and on
  over-constraint **which constraints conflict** — surfaced as a toast and
  inline highlight. Closed profiles are shaded (what's extrudable).
- **3D:** extrude a sketch profile into a solid on the **OpenCASCADE** kernel
  (replicad/OCCT WASM); export **STEP** (CAD/CNC) and **STL** (3D print).
  Extrude has new/join/cut, symmetric, **reverse direction** and
  **through-all** extents; plus **revolve**, edge **fillet / chamfer** (edge
  selectors: parallel to an axis, in a plane, near a point, in a box),
  **shell**, body **patterns** (linear / circular) and **mirror** (all bodies or
  just the last). Sketches can be started **on a body face** by picking a point
  (`sketch_on_face`), and every feature reports kernel errors and warnings
  (e.g. a cut that removed nothing).
- **Splines & involute gears:** an interpolating **spline** entity (exported
  as true cubic curves), and `sketch.addGear` — **external spur gears,
  internal ring gears and racks** generated the way they are cut: true involute
  flanks, trochoidal root fillets from the rack cutter's tip radius (with real
  undercut on small tooth counts), exact basic-rack conjugates with tangent
  root fillets, reference circles, backlash. See `docs/images/gear-*.png`.
- **Command-driven, with a parametric timeline separate from undo/redo.** Edit
  an earlier operation and it propagates downstream (Fusion-style), and that
  edit is undoable. Drag a point for live preview; release commits one step.
- **Persistence:** autosave to the browser, plus save/open `.chisel.json`.
- **MCP server** (`npm run mcp`) exposes every command to an LLM/agent — see
  [`mcp/README.md`](mcp/README.md).
- **Embedded Claude agent** (✦ Agent): bring your own Anthropic API key
  (stored only in your browser, sent only to Anthropic) and describe what to
  sketch — the agent drives the same commands through a tool-use loop and you
  watch the geometry build live.
- **Desktop app (optional, Tauri)** with a built-in **MCP server**: Settings →
  *Expose MCP server* serves the same tools to external MCP clients (Claude
  Code, Claude Desktop) over local HTTP, driving the **live document** you’re
  looking at. The website build is unaffected — see [Desktop app](#desktop-app-optional).
- **WebMCP** (Settings → *Expose tools to browser agents*): registers the same
  commands as MCP tools for external in-browser agents (an AI browser, a Chrome
  extension, Claude-in-Chrome) via `navigator.modelContext`, and always
  publishes `window.chiselWebMCP` (`.listTools()` / `.callTool(name, args)`) —
  no server, the page stays static.

See [`docs/SKETCHING.md`](docs/SKETCHING.md) for the Fusion-parity sketching
roadmap and what's done vs. planned.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design, the timeline-vs-undo
distinction, and the precision stance (float64 + relative tolerances + robust
predicates — what production kernels do).

## Getting started

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check (browser + mcp) + production build
npm run typecheck
npm run mcp          # build + run the MCP server over stdio
```

### Desktop app (optional)

The web app is the product and is what GitHub Pages serves; the desktop app is
an **opt-in Tauri shell** around the same build (`src-tauri/`). Nothing in
`npm run build`, CI or the Pages deploy touches Rust. It exists for one thing
the static site can’t do: **serve MCP to external clients.**

```bash
# prerequisites: Rust via rustup (src-tauri/rust-toolchain.toml pins a
# compatible version and rustup installs it on first use) + Xcode CLT on macOS
npm run tauri:dev    # live-reload dev window (runs `vite` for you)
npm run tauri:build  # .app / .dmg under src-tauri/target/release/bundle/
```

Then in the app: **Settings (⚙) → Expose MCP server (desktop app)**. The
status bar shows `● MCP :4673` and Settings shows the URL. It speaks MCP’s
Streamable HTTP transport, bound to 127.0.0.1 only, and the tools are exactly
the WebMCP set (every command, `get_state`, `render_view`, hotkeys) applied to
the open document:

```bash
claude mcp add --transport http chisel-cad http://127.0.0.1:4673/mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "chisel-cad": { "type": "http", "url": "http://127.0.0.1:4673/mcp" } } }
```

The toggle and port persist; the server starts with the app when enabled and
stops when the window closes. This is distinct from `npm run mcp`, the
**headless** stdio server that runs its own document with no UI.

### Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Orbit | Right-drag (sketch) / Left-drag (model) | Two-finger |
| Pan | Middle-drag | Two-finger |
| Zoom | Wheel | Pinch |
| Draw / select / drag | Left-click / drag | One-finger |
| Tools | `L` line · `R` rect · `C` circle · `A` arc · `P` point · `S` select | — |
| Frame / Look At | `F` (fit in model · align to plane in sketch) | — |
| Construction | `X` (toggle mode, or convert selection) | — |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | — |

All shortcuts are customizable in the hotkey manager (⌨ in the toolbar). On a
trackpad, two-finger scroll pans and pinch zooms; a mouse wheel zooms.

Select geometry, then apply constraints/dimensions from the context bar.

## Project layout

```
src/core/        pure, serializable, renderer-agnostic
  units          canonical mm + scale-aware tolerances
  document       the design intent (parameters, sketches, constraints) + timeline
  command        registry (→ MCP tools), validator, undo/redo + timeline session
  solver         neutral ConstraintSolver interface + PlaneGCS adapter + compile
  build/recompute replay the timeline, then solve
src/sketch       sketch data model
src/math         vectors, safe expression evaluator
src/viewport     three.js scene + pointer interactions (the renderer adapter)
src/ui           React shell (dispatches commands, never mutates the model)
mcp/             MCP server exposing the core to agents
```

## 3D, export & persistence

- **Extrude** a sketch profile into a solid on the OpenCASCADE kernel (holes via
  boolean cut), with a **parametric distance**. Export **STL** (3D print) and
  **STEP** (CAD/CNC) from the toolbar or over MCP.
- **Modify tools**: mirror, linear pattern, and construction (reference)
  geometry — all command-based, so they're parametric and undoable.
- **Save / Open** `.chisel.json` and **autosave** to the browser, so a reload
  restores your work. Files store just the operation recipe and rebuild on load.

## Customize mode

A slider-only view for tuning a parametric model to your dimensions, opened
straight from a URL:

```
?mode=customize&example=gyroscope      # a bundled example (public/examples/<name>.json)
?mode=customize&model=<url-to.json>    # any Chisel CAD model file
```

It shows just the 3D preview with the model's **bounded parameters** (those with
a min/max range or a value list — see the `⋯` editor in the Parameters panel)
as sliders and dropdowns, overlaid so the model stays visible — a floating card
on desktop, a bottom sheet on phones. Every change redraws the preview
immediately; after a short dwell a **motion study** runs on a dedicated worker
and a badge reports whether the configuration still works: *checking…* (with
progress) → *passes* or *fails*, naming what collides. The study sweeps each
driven revolute joint through a full 360° turn and fails if any two bodies
interpenetrate or the build errors — so a value that would jam or break the
mechanism is flagged before you print it.

**Save / share for printing** exports the whole configured model (all bodies in
one file, so a print-in-place assembly stays together) as a binary **STL**. On
a phone this goes through the native share sheet (Save to Files, AirDrop, or any
app that accepts the file); on desktop it downloads. Note: there is no direct
"web → Bambu Handy" path — Handy is not a slicer and doesn't import local STL /
3MF — so the file goes into **Bambu Studio** (or Bambu Connect) on a computer,
or is uploaded to **MakerWorld** for cloud slicing, then printed.

## Roadmap

- [x] Milestone 1: parametric 2D sketching (PlaneGCS)
- [x] Milestone 2: extrude profiles → OpenCASCADE solids + STL/STEP export
- [x] Persistence (save/open/autosave); mirror / pattern / construction geometry
- [ ] Revolve/loft, fillet/chamfer, boolean features between bodies
- [ ] Sketches on faces & construction planes; assemblies/joints
- [ ] In-viewport dimension editing; trim/offset; Tauri desktop packaging
```
