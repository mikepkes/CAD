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

## Sprint B — editing
- [x] Sketch-corner **Fillet** (tangent arc) / **Chamfer** (bevel) — trims both edges, rehomes corner constraints
- [x] **Trim** (T) — removes the clicked span between intersections; line/arc split or shorten, circle → arc, unbounded deletes. Curve–curve intersection module.
- [x] **Extend** (E) — lengthens a line/arc to the next curve it meets along its own path.
- [x] **Offset** — parallel copy of a single line/circle/arc at a signed distance (editable in timeline). Chain/loop offset is a follow-up.
- [x] Window/box select (window = solid, crossing = dashed), right-click context menu, `X` toggles construction, Look At (normal-to)

## Sprint C — breadth
- [x] **Collinear** constraint (parallel + point-on-line)
- [x] **Circular pattern** + **rectangular (grid) pattern**
- [x] **Driven (reference) dimensions** (measure without constraining; ⟨⟩ toggle in the inspector)
- [x] Point-to-center / center-to-center distance dimensions
- [x] **Polygon** (G) — regular N-gon via center + vertex, held regular by a construction circle (point-on-circle) + equal edges; sides editable in the timeline
- [ ] Rectangle: center, 3-point · Circle: 2-point, 3-point, tangent · Arc: 3-point, tangent (draw-tool flyouts)
- [ ] Ellipse, slot, spline (new entity kinds; PlaneGCS supports ellipse + b-spline)

## Milestone 4 — 3D workflow
- [x] **Project body edges** onto the active sketch (OCC edge extraction → fit lines/circles/arcs, dedupe, merge split circles). Snapshot (non-associative) for now; associative re-projection needs a dependency-ordered rebuild.
- [ ] Sketch on a body face (face pick → work plane)
- [ ] Construction / offset planes
- [ ] Intersect edges; revolve; 3D fillet / shell; components

## Deviations from Fusion (intentional)
- Agent-first: every tool is a documented MCP command.
- Parametric timeline + expression dimensions are first-class and visible.
- Skip rarely-used tools early (conic curves, sketch text) until the core loop is great.
- Keyboard/precision-first input suits CNC + agents.
