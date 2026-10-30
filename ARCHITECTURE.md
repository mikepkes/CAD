# Architecture

Chisel CAD is a **local-first, static** parametric CAD app. It runs entirely in
the browser (no server), so it can be served from GitHub Pages. Server/cloud
features can be layered on later without changing the core.

Four principles drive the design:

1. **Commands are the only way to change the model.** Every mutation is a
   documented, schema-validated command. The command history is both undo/redo
   and the parametric timeline. The same command registry is exposed to an LLM
   as MCP tools, so an agent and the UI share one vocabulary.
2. **The math solve is the source of truth, not the picture.** The model is
   analytic (exact constraints and, later, B-rep solids via OpenCASCADE).
   Tessellation is derived, display-only. This is what makes output
   CNC/3D-print ready.
3. **Renderer-agnostic core.** The core knows nothing about three.js. It emits a
   neutral evaluated model; an adapter renders it. three.js today, something
   else (e.g. Unreal) tomorrow.
4. **float64 everywhere, robustness via tolerances + robust predicates** — the
   same choice every production kernel makes (see "Precision").

## Layers

The layering is enforced in CI by `test/layering.test.ts`: each pure directory
(`core`, `sim`, `sketch`, `geometry`, `math`, `util`) may import only from an
allow-list. It may not import renderer, UI or app packages (three, react,
zustand, Tauri, MCP SDK), and it may not use DOM globals. Platform adapters
(the Web Worker backend, hotkeys) live in `src/model/`.

```
src/core/                     pure, serializable, no three.js / no DOM
  units.ts                    canonical mm, scale-aware tolerance model
  document.ts                 CadDocument: the design intent (params, sketches, constraints)
  command/
    types.ts                  Command + JSON-Schema types
    validate.ts               dependency-free schema validator
    registry.ts               command registry  →  MCP tool surface
    builtins.ts               the built-in commands
    session.ts                dispatch + undo/redo + over-constraint guard
  solver/
    model.ts                  neutral ConstraintSolver interface + diagnosis
    compile.ts                Sketch (+ parameters)  →  neutral SolverModel
    planegcs.ts               PlaneGCS (FreeCAD) adapter — primary solver
  recompute.ts                resolve params → solve every sketch → write back
src/sketch/                   sketch model + (legacy) native solver
src/math/                     vectors, safe expression evaluator
adapters (planned)
  three/                      renders the evaluated model
  mcp/                        serves registry.toMcpTools() to an agent
```

## Data flow

```
 user / agent
      │  dispatch(commandType, params)
      ▼
 CadSession ──► command.apply(draftDoc)        (mutate design intent)
      │
      ▼
 recompute(doc, solver)
      │   for each sketch:  compileSketch → solver.solve → write solved coords
      ▼
 Evaluations (DoF, conflicts, redundancies)  ──►  UI hints / agent feedback
```

### Timeline vs. undo (they are different things)

- The **timeline** is `doc.operations` — the ordered recipe that *defines* the
  model. `build.rebuild` replays the active prefix (`operations[0..rollbackIndex)`)
  to derive geometry. You can edit it anywhere: append, **edit an earlier
  operation's params**, suppress, delete, or move the rollback bar — and the
  replay propagates the change downstream. This is Fusion's feature tree.
- **Undo/redo** is a *separate* stack of whole-document snapshots taken around
  each edit. Editing an early operation is itself one undoable transaction:
  undo restores the prior document (the old op params *and* the downstream
  result). So "modify an early sketch, see it propagate" and "undo that" are
  both first-class, and they never get conflated.

Replay stays stable because each operation **permanently owns the ids it
created** (`op.createdIds`, reused verbatim on every replay); only genuinely new
allocations advance `doc.nextId`. That is what keeps later operations'
references valid when an earlier one is edited.

## Solids: incremental evaluation and topological naming

`core/features.ts` folds the feature list into bodies on the OpenCASCADE kernel.
It runs in a Web Worker in the app and inline in tests and the stdio server.

- **Input-keyed step cache.** Each feature step is keyed by a hash of its
  inputs:
  - its own definition (minus derived `*Value` fields);
  - the solved geometry of the sketches it reads;
  - the parameter values its expressions mention;
  - its instance frame;
  - the content signatures of the bodies it reads (its target, or every body
    for a mirror or a face-referenced sketch).

  A repeated key replays the step's recorded effect — the bodies it added or
  changed (shared OCC handles), face names, its row, any re-resolved face
  planes — without touching the kernel. A body's signature is the key of the
  step that last changed it. So independent bodies never invalidate each
  other, and an edit re-runs only what is downstream of it. Meshes and mass
  properties are cached per body signature.
- **Topological naming** (`core/naming.ts`). Faces are named where they are
  made: `extrude3:start|end|side:<curveId>`, `revolve4:rev:<curveId>`,
  `prim2:+X`, `hole9:bore`, `import5:f0`. The names carry forward by kernel
  provenance:
  - Booleans use `BRepAlgoAPI` `Modified`/`IsDeleted` history, including
    `SimplifyResult` merges.
  - Fillet, chamfer and shell keep a face's `Geom_Surface`.
  - Transforms keep face order.
  - Faces an operation creates are named by it and their neighbours
    (`fillet6:blend(…)`, `shell7:inner(prim2:+X)`).

  Edges are named by the faces they separate (`A|B`). A sketch's `faceRef`
  pins a face name at pick time and resolves by name first, falling back to
  normal + nearest point. Fillet/chamfer selectors accept edge `names`.
- **Reference values.** `test/oracle.test.ts` checks the exact B-rep volume,
  surface area and centroid of every feature kind against closed-form answers.

## Constraint solving & diagnosis

The 2D constraint solver is **PlaneGCS**, FreeCAD's battle-tested geometric
constraint solver, compiled to WebAssembly
([`@salusoft89/planegcs`](https://www.npmjs.com/package/@salusoft89/planegcs)).
It is wrapped behind the neutral `ConstraintSolver` interface, so it can be run
in a Web Worker and swapped out.

Each constraint is pushed with **our** id, so the solver reports back:

- **DoF** — `0` means *fully constrained* (surfaced as a hint).
- **Conflicting** constraint ids — the set that cannot be satisfied together.
- **Redundant / partially-redundant** ids.

Because constraints are added one command at a time, the `CadSession`
**over-constraint guard** knows that when a command tips a sketch into conflict,
*that command's* constraint is the culprit. It can reject the command and return
exactly which constraints clash — so a user or an agent can self-correct instead
of staring at a globally "over-constrained" sketch.

## Precision

All model math is IEEE-754 `float64` (double) in canonical **millimetres** —
the same representation OpenCASCADE, Parasolid and ACIS use. Robustness for very
small and very large parts does **not** come from wider number types (which
would break kernel interop and performance); it comes from:

- a **relative tolerance model** (`src/core/units.ts`) that scales with feature
  size, and
- **exact geometric predicates**
  ([`robust-predicates`](https://www.npmjs.com/package/robust-predicates),
  Shewchuk's adaptive-precision `orient2d/orient3d/incircle/insphere`) for the
  sign-exact tests where rounding would otherwise flip topology.

## MCP / agent interface

`registry.toMcpTools()` turns every command into an MCP tool: the tool name is
the command type, and the description carries the summary, long description and
worked examples, with the params JSON Schema as the input schema. An agent
dispatching `{type, params}` goes through the exact same validated path as the
UI, and gets back the created ids plus the solve diagnosis (DoF, conflicts).

## Licensing note

PlaneGCS is **LGPL-2.0-or-later** (used as a WebAssembly module).
`robust-predicates` is public domain (Unlicense). OpenCASCADE (planned) is
LGPL-2.1-with-exception.
