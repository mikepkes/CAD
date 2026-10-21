# Chisel CAD

A browser-based parametric 3D CAD application. The long-term goal is a
Fusion 360–style modeler with components, 3D sketches, and solid modeling on an
**OpenCASCADE** geometry kernel. This first milestone focuses on getting **2D
constraint sketching** excellent.

## Status — Milestone 1: 2D sketching

Working today:

- **3D viewport** (three.js, Z-up) with the three origin planes (XY / XZ / YZ),
  grid, world axes, and orbit / pan / zoom. Works with mouse and touch.
- **Sketch on any origin plane** — pick a plane and the camera faces it.
- **Drawing tools**: line (chained), rectangle, circle, arc, point, with live
  rubber-band preview, point/grid snapping, and automatic horizontal/vertical
  inference.
- **Geometric constraints**: coincident, horizontal, vertical, parallel,
  perpendicular, equal, tangent, concentric, point-on-line, point-on-circle,
  symmetric, fix.
- **Dimensional constraints**: distance, horizontal/vertical distance,
  point-to-line distance, radius, diameter, angle.
- **Parametric dimensions** — every dimension is an expression that can
  reference named **parameters** (e.g. `width`, `width/2`, `rad(30)`). Edit a
  parameter and the model re-solves.
- **Constraint solver** — a native Levenberg–Marquardt solver (`src/solver`)
  with live dragging, degrees-of-freedom analysis, a **fully-constrained**
  indicator, and over-constrained detection.
- **Browser / parameters / inspector** panels, Fusion-style.

### Why a custom 2D solver (and where OpenCASCADE fits)

OpenCASCADE (OCCT) is a B-rep **3D** kernel — it does not ship a 2D geometric
*constraint* solver, which is what makes sketching feel parametric. So the 2D
constraint engine here is written in pure TypeScript (portable, fast, no WASM
load cost on phone/iPad). OCCT (via `opencascade.js`) will be brought in for the
**3D** milestone (extrude / revolve / fillet / boolean on the solved profiles).

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
npm run typecheck
```

### Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Orbit | Right-drag (sketch) / Left-drag (model) | Two-finger |
| Pan | Middle-drag | Two-finger |
| Zoom | Wheel | Pinch |
| Draw / select | Left-click | One-finger |
| Tool shortcuts | `L` line · `R` rect · `C` circle · `A` arc · `P` point · `S` select · `Esc` cancel | — |

Select geometry, then apply constraints/dimensions from the context bar.

## Architecture

```
src/
  math/        vectors, safe expression evaluator (parameters)
  solver/      generic Levenberg–Marquardt constraint solver
  sketch/      sketch data model + constraint→residual compiler (engine.ts)
  geometry/    origin work-plane definitions (2D↔3D mapping)
  model/       zustand store, parameters, selection→operations
  viewport/    three.js scene, sketch rendering, pointer interactions
  ui/          React components (toolbar, panels, viewport host)
```

The solver and sketch engine are free of three.js and React, so they are
unit-testable and reusable (e.g. for 3D assembly mates later).

## Roadmap

- [ ] Milestone 2: profiles → OpenCASCADE extrude/revolve to solids
- [ ] Features timeline, fillet/chamfer, boolean ops
- [ ] Sketches on arbitrary faces & construction planes
- [ ] Assemblies / joints across components
- [ ] Persistence (document save/load) and Tauri desktop packaging
```
