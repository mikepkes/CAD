# Chisel CAD

**Live demo: https://mikepkes.github.io/CAD/**

**Try the parametric customize mode** (slider-only product tuning, with a live
pass/fail motion study):
**https://mikepkes.github.io/CAD/?mode=customize&example=gyroscope** — drag the
sliders to resize the print-in-place gyroscope gimbal; after a short dwell it
sweeps both rings through a full turn and tells you whether the chosen
dimensions still rotate freely or jam.

Or try **https://mikepkes.github.io/CAD/?mode=customize&example=scissor** — a
parametric scissor lift whose **number of linkages** is itself a slider
(`stages`, stepped to whole numbers), alongside the opening angle and link
size. It shows off a **parametric pattern count**: the repeat is driven by a
parameter, so dragging `stages` restamps the mechanism taller or shorter.

And **https://mikepkes.github.io/CAD/?mode=customize&example=scissor-jointed** —
the same scissor, but **jointed**: a component pattern + relational joint
templates, so `stages` sets the number of linkages *and* the mechanism still
articulates (drag `theta` to collapse/extend it). Patterning a component and
keeping it jointed is something Fusion 360 cannot do — see
[Parametric jointed assemblies](#parametric-jointed-assemblies-prototype) below.

And **https://mikepkes.github.io/CAD/?mode=customize&example=starbox** — a
snap-together **star box**: two copies of one androgynous half clip together,
with a snap and an anti-twist key on every edge. Drag `width` and `height` to
size it, and pick what you print it in from `material` (PLA, PETG, ABS / ASA,
nylon, TPU 68D or TPU 95A). The snaps resize for that material: tongue
thickness, how far the barb deflects it, fit clearance and the lead-in angle,
sized with the beam solver to stay within the material's strain limit across
the print layers. It opens on the single half you print (print it twice); tick
`fullBox` to see the closed box.

### Compliant mechanisms

Parts that move by **bending** instead of sliding on pins, printed flat as one
piece. Chisel solves how they move and what the bending costs: the strain in
every flexing strip against the material's limit, the force to drive it, and
where it comes to rest. Each one has a `material` dropdown that checks the
strain against what you print it in; in the four-bar and the gripper the hinge
strips also resize for it. How it works is in
[docs/COMPLIANT.md](docs/COMPLIANT.md).

- **Four-bar linkage:** https://mikepkes.github.io/CAD/?mode=customize&example=fourbar
  - **What it is:** four links joined by thin hinge strips.
  - **Push it:** drag `theta` to push the finger pad and the pointer swings. A
    live readout shows each hinge's strain, the input torque and the stored
    energy.
  - **Reshape it:** `crank`, `rocker` and `ground` change the linkage. A longer
    crank or a shorter rocker makes the pointer swing further.
- **Bistable switch:** https://mikepkes.github.io/CAD/?mode=customize&example=bistable
  - **What it is:** two curved beams span a stout ring frame and carry a
    shuttle. Push its knob down and the beams snap through to their mirror
    shape, where it stays until you push it back up.
  - **The readout:** both rest positions, the force to snap it over, and the
    beams' strain on the way.
  - **The physics:** the beams are solved as large-deflection beams, settling
    into stable shapes. For slender beams, the snap force matches the
    published result for this mechanism to within 3%. This switch's stockier
    beams tip over sooner and snap a little lower. The frame is solved too: the beams push its walls
    apart as they flip, and a frame that gives loses the second rest position.
    (The first version, a U-frame, did exactly that once printed.)
  - **Material:** the material sizes the beams. Each one gets the stoutest beams
    that snap within its strain limit: about 12 N to flip in TPU 68D, 6 N in PLA.
  - **Skeleton:** tick it to embed a PLA core in the frame's bars, under a
    1.2 mm skin, for a two-material print (it saves as a 3MF). The model counts
    the stiffer bars. It matters most with a soft TPU: in TPU 95A the snap rises
    to the rigid-frame value. TPU 68D's own frame is already close.
  - **Try:** `span`, `arch` (rise over thickness) and `frame`. A flat arch
    stops being bistable and just springs back.
- **Gripper:** https://mikepkes.github.io/CAD/?mode=customize&example=gripper
  - **What it is:** push the plunger and both jaws swing open; let go and they
    spring shut on whatever is between them.
  - **What it solves:** 8 parts, 10 hinges and 3 closed loops, together. The
    plunger rides a parallelogram guide, and pushrods turn the jaw levers, so
    each jaw tip moves about 3.7× as far as the plunger.
  - **Grip strength:** `springs` adds up to three leaf springs from the frame
    to the plunger. Each adds about 10 N of push at full stroke in TPU 68D, so
    the grip on a held object goes 1.4 → 2.1 → 2.7 → 3.3 N per jaw.
  - **Skeleton:** tick it to put a PLA core in every rigid link, for a
    two-material print (it saves as a 3MF). The model treats the links as
    rigid; in a soft TPU, the core makes them so. The hinges stay TPU.
  - **Try:** `jaw` changes the lever length.
- **XY stage:** https://mikepkes.github.io/CAD/?mode=customize&example=xystage
  - **What it is:** a platform that moves in X and Y on thin blades, with two
    inputs. A carriage hangs in the frame on four vertical blades and moves in
    X; the platform hangs in the carriage on four horizontal blades and moves in
    Y.
  - **The physics:** the blades are solved as beams. Each stage's sideways
    drift and turn aren't set by any input, so Chisel lets them settle where
    the stored energy is least.
  - **The redundancy:** the blades on either side hold each stage centred
    against each other, so they must stretch. That makes the stage stiffen with
    travel, which is why precision stages use double parallelograms instead.
  - **Try:** `blade` length and `thickness`.
- **Snap fits:** the star box above. Its tongues are cantilever springs, sized
  per material with the same beam solver.

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
  (replicad/OCCT WASM); export **STEP** (CAD/CNC), **STL** (3D print) and
  **3MF** (a part per material, for multi-material prints).
  Extrude has new/join/cut, symmetric, **reverse direction** and
  **through-all** extents; plus **revolve**, edge **fillet / chamfer** (edge
  selectors: parallel to an axis, in a plane, near a point, in a box),
  **shell**, body **patterns** (linear / circular) and **mirror** (all bodies or
  just the last). Sketches can be started **on a body face** by picking a point
  or naming the face (`sketch_on_face`), and every feature reports kernel
  errors and warnings (e.g. a cut that removed nothing). **Import** STEP,
  OpenCASCADE BREP, STL (sewn into a faceted solid), FreeCAD `.FCStd` (each
  visible solid) and Rhino `.3dm` as bodies (File → Import, or `import_file`).
  Rhino Breps, extrusions and surfaces come in **exact**, as NURBS surfaces
  with their trims sewn into solids; meshes come in as they are. For IGES,
  export STEP instead.
- **Topological naming:** every face is named by the feature that made it
  (`extrude3:end`, `extrude3:side:line7`, `prim2:+X`, `hole9:bore`) and keeps
  that name through later booleans, fillets, shells and patterns, via
  OpenCASCADE's own history. A sketch on a face follows that face through
  upstream edits; fillets and chamfers can pick edges by name (`A|B`).
- **Configuration tables:** named design variants (Parameters panel →
  Configurations, or `configuration.create`). Each row overrides parameter
  expressions and can suppress features. Activating a row (`set_configuration`)
  switches the whole model — solids, collisions, motion studies, exports —
  without touching the timeline, and switching back replays from cache.
  `export_model { all: true }` writes one file per configuration.
- **Visibility:** hide or show bodies, sketches, components and datum planes
  with the eye toggles. Hiding a component hides everything in it. **◉** shows
  everything and **◎** draws hidden bodies as faint ghosts. It's display only
  (hidden bodies still export and measure), it's undoable, and it's saved. A
  configuration can hide things too, and agents use `set_visibility` /
  `isolate` to frame one part for `render_view`.
- **Surface modelling:** `feature.surface` makes surface bodies (area, no
  volume) from open or closed sketch curves: extrude, revolve, loft, sweep, or a
  flat patch. Then **trim** them by a sketch region or another body (keep inside
  or outside), **untrim** to fill cut-outs, **stitch** surfaces along shared
  edges into one (a solid when they close up; a gap is reported), and
  **thicken** a surface into a solid on either side or straddling it.
- **3D mouse:** a 3Dconnexion SpaceMouse orbits, pans and zooms the view, and
  in a sketch it only pans and zooms. The desktop app reads it natively (alongside
  3Dconnexion's driver). Chrome and Edge pair it through WebHID from
  Settings. Speed, axis inversion, rotation lock and the two buttons (fit,
  standard views, undo…) are set in Settings.
- **Weldments:** `feature.member` lays a structural profile (rect, square or
  round tube, round bar, flat, angle, channel, I-beam, or a custom sketch)
  along every line of a layout sketch, one body per member. Corners are
  mitred, butted, or left as drawn, with optional end caps and gusset plates.
  The **cut list** (Inspector, or `cut_list`) groups members by profile, cut
  length and end angles, and exports CSV.
- **Sheet metal and paper:** `feature.sheet` folds a flat blank (a closed
  sketch, with fold lines drawn as construction lines) or unrolls an open run
  of lines into a contour flange. Thickness, bend radius and K-factor are set
  once for the part. Bends wrap the blank exactly onto their radius, so the
  flat length is Σ straights + Σ bend allowances. Add **edge flanges** and
  **hems** (`feature.flange`: bend outside, material inside or outside, insets,
  automatic relief slots and open-corner reliefs), **sketched bends** and
  **jogs** (`feature.fold`), and **unfold → cut → refold** to cut holes across
  bends. Paper is the same model with sharp creases (radius 0) and thickness 0
  or a small one. Creases can meet at vertices, and a crease left without an
  angle is solved so every vertex closes up (rigid origami): drive one crease
  and the rest follow, or get told which vertex can't fold. The **flat
  pattern** (Inspector, or `flat_pattern`) exports SVG or DXF, with valley and
  mountain fold lines.
- **Surface analysis:** the toolbar switches the shaded view to **zebra**
  stripes (they break at a crease, kink at a tangent-only seam and flow through
  a curvature-continuous one), a **curvature** map (mean / Gaussian / max / min,
  computed from the exact B-rep), or a **draft** check against a pull
  direction. **Combs** draws curvature combs on curved edges and sketch curves.
  Agents get the numbers from `surface_analysis`: curvature ranges, and
  G0/G1/G2 continuity for every edge by name.
- **Incremental rebuild:** each feature step is cached by its inputs, so an
  edit re-runs only the features downstream of it on the bodies it touches.
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
the WebMCP set applied to the open document. That set is every command, plus
`get_state`, `render_view`, `measure`, `body_topology` and `batch` (an atomic
transaction that rolls back on the first failing step), plus hotkeys. Every
tool carries MCP annotations (read-only / destructive):

```bash
claude mcp add --transport http chisel-cad http://127.0.0.1:4673/mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "chisel-cad": { "type": "http", "url": "http://127.0.0.1:4673/mcp" } } }
```

Renders can go to disk: `render_view` takes a free camera (`azimuthDeg`,
`elevationDeg`, `fovDeg`, `rollDeg`) and a `saveAs` filename, and
`record_turntable` records a 360° WebCodecs video (H.264, VP9 fallback) and
saves the MP4. Desktop saves land in `~/Downloads/Chisel CAD/` — clients name
the file, not the folder, and a symlinked folder or file is refused.

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
src/core/        pure, serializable, renderer-agnostic (CI-enforced: test/layering)
  units          canonical mm + scale-aware tolerances
  document       the design intent (parameters, sketches, constraints) + timeline
  command        registry (→ MCP tools), validator, undo/redo + timeline session
  solver         neutral ConstraintSolver interface + PlaneGCS adapter + compile
  build/recompute replay the timeline, then solve
  features       B-rep evaluation, with the input-keyed step cache
  naming         topological face/edge names
  occ/kernel     the only module that touches OpenCASCADE
src/sketch       sketch data model
src/math         vectors, safe expression evaluator
src/viewport     three.js scene + pointer interactions (the renderer adapter)
src/ui           React shell (dispatches commands, never mutates the model)
mcp/             MCP server exposing the core to agents
```

## 3D, export & persistence

- **Extrude** a sketch profile into a solid on the OpenCASCADE kernel (holes via
  boolean cut), with a **parametric distance**. Export **STL** (3D print) and
  **STEP** (CAD/CNC) from the toolbar or over MCP, and **3MF** from the toolbar.
- **Optional parts:** `feature.setCondition { feature, when }` builds a feature
  only while an expression is non-zero. A checkbox parameter can then switch a
  part on or off, such as an insert or a second-material core.
- **Modify tools**: mirror, linear pattern, and construction (reference)
  geometry — all command-based, so they're parametric and undoable.
- **Save / Open** `.chisel.json` and **autosave** to the browser, so a reload
  restores your work. Files store just the operation recipe and rebuild on load.

## Customize mode

A slider-only view for tuning a parametric model to your dimensions, opened
straight from a URL:

```
?mode=customize&example=gyroscope      # a bundled example (public/examples/<name>.json)
?mode=customize&example=scissor        # a parametric scissor lift (linkage count is a slider)
?mode=customize&example=scissor-jointed # the scissor as a jointed assembly (count + articulates)
?mode=customize&example=starbox        # snap-together star box: width + height sliders, print material dropdown; opens on the one printable half, tick fullBox for both (one flipped)
?mode=customize&example=fourbar        # compliant four-bar: flexure hinges, a closed loop, live hinge strain; link-length sliders, print material dropdown
?mode=customize&example=bistable       # bistable switch: curved beams that snap between two rest positions; span / arch / frame sliders
?mode=customize&example=gripper        # compliant gripper: 10 hinges, 3 loops, amplified jaws; jaw length slider, grip springs, PLA skeleton
?mode=customize&example=xystage        # XY flexure stage: two inputs, blades as beams, drift settled at minimum energy; blade sliders
?mode=customize&model=<url-to.json>    # any Chisel CAD model file
```

It shows just the 3D preview with the model's **bounded parameters** (those with
a min/max range, a value list, a checkbox or named choices — see the `⋯` editor
in the Parameters panel) as sliders, dropdowns and checkboxes, overlaid so the
model stays visible — a floating card on desktop, a bottom sheet on phones. Every change redraws the preview
immediately; after a short dwell a **motion study** runs on a dedicated worker
and a badge reports whether the configuration still works: *checking…* (with
progress) → *passes* or *fails*, naming what collides. The study sweeps each
driven revolute joint through a full 360° turn and fails if any two bodies
interpenetrate or the build errors — so a value that would jam or break the
mechanism is flagged before you print it.

A **named choice** (an enum, such as the star box's print `material`) is a
dropdown of names whose value is the chosen index, 0, 1, 2…. Other parameters
follow it with `pick`, e.g. `pick(material, 0.75, 1.1, 1.0)`, and
`material.assign` with `materials` + `by` makes a component's material follow it
too, so the preview shows the chosen filament.

**Save / share for printing** exports the whole configured model (all bodies in
one file, so a print-in-place assembly stays together) as a binary **STL**.
When the model has more than one print material, it exports a **3MF** instead:
one object with a part per material, in place, named and coloured after it.
Bambu Studio, Orca and PrusaSlicer load that as one object with several parts,
and you pick each part's filament. On
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

## Parametric jointed assemblies (prototype)

Most CAD (Fusion 360 included) lets you pattern a *component*, but the copies
come out **rigid** — the joints don't come along, so you can't have a mechanism
whose instance count is a parameter *and* still articulates. Chisel prototypes
exactly that. Three pieces make it work:

- **Connectors** — named attachment frames (joint origins) on a component, in
  its local coordinates (`component.connector`). A relational joint binds to
  these by name rather than to raw coordinates.
- **Component patterns** — duplicate a component subtree a *parametric* number
  of times (`assembly.pattern`, `count` an expression like `"stages"`).
- **Joint templates** — relational joints addressed by role: `self` → instance
  *i*, `prev` → *i-1*, `root` → ground, each with a `port` (connector name) and
  a `value` expression that may use the instance index `i` (`joint.template`,
  `appliesTo: first | rest | all`).

At rebuild an **expander** (`src/core/assembly.ts`) stamps the rule into
concrete instances and joints, with deterministic ids
(`pattern#i__localId`) so selections and caches stay stable as the count
changes. Everything downstream — the tree-based assembly FK, the geometry
pipeline, the motion study — then runs unchanged.

**Fast render path.** The instance geometry is *not* rebuilt with the kernel
per copy. The source body is evaluated once (and stays cacheable — it doesn't
depend on the joint-drive parameters); each instance is produced by transforming
that baked mesh by its joint-driven world. So articulating the mechanism or
dragging the count is `O(instances)` vertex math, not `O(instances)` OCC builds —
smooth even as the count climbs. (`collide`/`export` still expand-and-rebuild,
since they need real B-reps.)

**Authoring UI.** The Browser panel shows each component's connectors, the
component patterns (with an editable count expression), and their joint
templates (editable drive value and `appliesTo`), with inline forms to add a
connector, pattern a component, or add a joint template — and delete buttons for
each. Everything is also scriptable via the commands above.

Closed loops (a scissor is one per stage) use the same trick the hand-built
jointed models use: each joint's `value` is an expression of one driver, so the
tree FK reproduces the loop without a loop solver. That covers regular,
repeating mechanisms (the common case). A general loop-closure solver — for
irregular linkages whose closure isn't expressible in closed form — is the
natural next step.

Current limits: instances are derived (not individually selectable yet), and a
body fused across several components of the patterned subtree is placed by a
single frame (single-component bodies — the common case — are exact). See
`test/assembly.test.ts`, `test/backend_assembly.test.ts` and
`test/scissor_jointed.build.test.ts` (which checks the fast path matches a full
rebuild).
