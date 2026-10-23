# Sketching roadmap — toward Fusion 360 parity

Goal: make the sketch environment feel like Fusion 360, deviating where it
helps (agent-first commands, parametric timeline, precision/keyboard input,
local-first). Everything stays command-driven (undoable, MCP-exposed).

## Sprint A — the "feel" sprint
- [ ] A1 Constraint inference while drawing + rich snapping
  - [ ] snap targets: endpoint (have), center (have), **midpoint**, **on-curve**, **intersection**
  - [ ] inference: H/V (have), **parallel / perpendicular** to existing lines, **coincident / point-on-line** when ending on geometry, **tangent**
  - [ ] on-screen inference markers; apply inferred constraints on commit
  - [ ] new constraints needed: **midpoint**, **collinear**
- [ ] A2 Constrained-state coloring + profile shading
  - [x] under-constrained = blue, fully constrained = light, conflicting = red
  - [x] shade closed profiles (what's extrudable)
  - [ ] per-entity DOF coloring (needs solver Jacobian introspection — follow-up)
  - [ ] click a shaded profile to extrude just it
- [ ] A3 Dimension tool + in-canvas editing
  - [ ] modal Dimension tool (`D`), smart by selection
  - [ ] inline value input on placement (number or parameter expression)
  - [ ] double-click a dimension in the viewport to edit

## Sprint B — editing
- [ ] Trim, Extend, Offset, sketch-corner Fillet / Chamfer
- [ ] Window/box select, right-click context menu, `X` toggles construction, Look At

## Sprint C — breadth
- [ ] Rectangle: center, 3-point · Circle: 2-point, 3-point, tangent · Arc: 3-point, tangent
- [ ] Ellipse, slot, polygon, spline (PlaneGCS supports ellipse + b-spline)
- [ ] Circular pattern, rectangular (grid) pattern
- [ ] Driven (reference) dimensions; point-to-circle / circle-to-circle distances

## Later (needs 3D)
- [ ] Sketch on a body face; construction / offset planes; project / intersect edges

## Deviations from Fusion (intentional)
- Agent-first: every tool is a documented MCP command.
- Parametric timeline + expression dimensions are first-class and visible.
- Skip rarely-used tools early (conic curves, sketch text) until the core loop is great.
- Keyboard/precision-first input suits CNC + agents.
