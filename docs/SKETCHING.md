# Sketching roadmap — toward Fusion 360 parity

Goal: make the sketch environment feel like Fusion 360, deviating where it
helps (agent-first commands, parametric timeline, precision/keyboard input,
local-first). Everything stays command-driven (undoable, MCP-exposed).

## Sprint A — the "feel" sprint
- [x] A1 Constraint inference while drawing + rich snapping
  - [x] snap targets: endpoint, center, **midpoint**, **on-curve (line projection)** — intersection/tangent deferred to Sprint C
  - [x] inference: H/V, **parallel / perpendicular** to existing lines, **coincident / point-on-line** when ending on geometry — tangent deferred
  - [x] on-screen inference markers; apply inferred constraints on commit
  - [x] new constraint: **midpoint** (collinear deferred to Sprint C)
- [ ] A2 Constrained-state coloring + profile shading
  - [x] under-constrained = blue, fully constrained = light, conflicting = red
  - [x] shade closed profiles (what's extrudable)
  - [ ] per-entity DOF coloring (needs solver Jacobian introspection — follow-up)
  - [ ] click a shaded profile to extrude just it
- [x] A3 Dimension tool + in-canvas editing
  - [x] modal Dimension tool (`D`), smart by selection (reuses availableOps)
  - [x] inline value input on placement (number or parameter expression)
  - [x] double-click a dimension in the viewport to edit
  - [x] Fusion-style annotations: extension lines + dimension line + arrowheads + value (distance/X/Y, radius, diameter, angle, point-line), with a **draggable offset** stored per dimension (undoable)

## Sprint B — editing
- [x] Sketch-corner **Fillet** (tangent arc) / **Chamfer** (bevel) — trims both edges, rehomes corner constraints
- [x] **Trim** (T) — removes the clicked span between intersections; line/arc split or shorten, circle → arc, unbounded deletes. Curve–curve intersection module.
- [x] **Extend** (E) — lengthens a line/arc to the next curve it meets along its own path.
- [x] **Offset** — parallel copy of a single line/circle/arc at a signed distance (editable in timeline). Chain/loop offset is a follow-up.
- [x] Window/box select (window = solid, crossing = dashed), right-click context menu, `X` toggles construction
- [x] **Animated camera transition** into a sketch: from the current view (perspective or ortho), smoothly arcs into an **orthographic**, plane-aligned view; perspective 3D restored on finish. **Look At** animates back to the sketch view after you rotate out.
- [x] **Explicit constraint palette** (Fusion-style): always-visible Constrain row — click a constraint (Coincident, Parallel, …), then click the entities; or with a selection that already fits, it applies on click. Armed tool stays active for repeated use; Esc exits.

## Sprint C — breadth
- [x] **Collinear** constraint (parallel + point-on-line)
- [x] **Circular pattern** + **rectangular (grid) pattern**
- [x] **Driven (reference) dimensions** (measure without constraining; ⟨⟩ toggle in the inspector)
- [x] Point-to-center / center-to-center distance dimensions
- [x] **Polygon** (G) — regular N-gon via center + vertex, held regular by a construction circle (point-on-circle) + equal edges; sides editable in the timeline
- [x] Draw-tool variants via a variant selector: **Circle** center / 2-point / 3-point · **Rectangle** 2-corner / center / 3-point (rotated) · **Arc** center / 3-point
- [x] **Slot** tool (two centers + width → 2 lines + 2 tangent arcs, equal + parallel)
- [x] **Ellipse** (I) — center + major-axis + minor-extent; renders, shades, and extrudes (OCC drawEllipse). Center is a solver point; shape (rx/ry/rotation) is set at draw time and editable in the timeline. Solver-driven ellipse shape (PlaneGCS ellipse/arc-of-ellipse) is a follow-up.
- [ ] Circle/arc tangent variants
- [ ] Spline (b-spline entity: model + solver + OCC + profile) — larger, deferred

## Milestone 4 — 3D workflow
- [x] **Project body edges** onto the active sketch (OCC edge extraction → fit lines/circles/arcs, dedupe, merge split circles). Snapshot (non-associative) for now; associative re-projection needs a dependency-ordered rebuild.
- [x] **Sketch on a body face** — pick a solid face in model mode → a work plane coincident with it (stable origin at the perpendicular foot from the world origin)
- [x] **Offset planes** — start a sketch offset along an origin plane's normal (offset field in the toolbar)
- [x] Generalized work planes (arbitrary origin/normal stored on the sketch); renderer/interactions/features all plane-agnostic
- [ ] Intersect edges; revolve; 3D fillet / shell; components

## Deviations from Fusion (intentional)
- Agent-first: every tool is a documented MCP command.
- Parametric timeline + expression dimensions are first-class and visible.
- Skip rarely-used tools early (conic curves, sketch text) until the core loop is great.
- Keyboard/precision-first input suits CNC + agents.
