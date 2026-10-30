# Chisel CAD — MCP server

An MCP server that exposes the Chisel CAD core to an LLM/agent. The core runs
headless here (PlaneGCS via WebAssembly), so an agent can build and edit
parametric, CNC/3D-print-ready models with no browser.

> **Two ways to get MCP.** This directory is the **headless** server: its own
> document, no UI, stdio transport — right for batch/agent-only use. The
> optional **desktop app** (`npm run tauri:dev`, see the root README) instead
> serves MCP over local HTTP *from the running app*, so a client edits the
> document you are looking at, and can `render_view` it. Enable it in Settings.

## Run

```bash
npm run mcp          # builds dist-mcp/server.mjs and launches it over stdio
# or build once and run the bundle directly:
npm run mcp:build
node dist-mcp/server.mjs
```

### Connect from an MCP client

Point any MCP client at the built server over stdio. Example (Claude Desktop
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "chisel-cad": {
      "command": "node",
      "args": ["/absolute/path/to/CAD/dist-mcp/server.mjs"]
    }
  }
}
```

## Tools

Every document command is a tool (dots become `__`, e.g. `sketch.addLine` →
`sketch__addLine`). Each advertises a JSON-Schema `inputSchema` and examples, so
the agent has everything it needs to call it. Command tools:

- `parameter__add`, `parameter__set`, `parameter__delete`
- `sketch__create` (plane / offset / datum / `planeDef`), `plane__create`,
  `component__create`
- geometry: `sketch__addPoint`, `addLine`, `addPolyline`, `addCircle`, `addRing`,
  `addArc`, `addEllipse`, `addRectangle` (`cornerRadius`), `addRectangle3`,
  `addBar`, `addSlot`, `addPolygon`, `addSpline`, **`addGear`** (external /
  internal / rack involute gears)
- edit: `sketch__trim`, `extend`, `offset`, `offsetLoop`, `fillet` (by lines or
  corner point), `filletCorners`, `chamfer`, `mirror`, `linearPattern`,
  `circularPattern`, `gridPattern`, `setConstruction`, `moveGeometry`,
  `projectCurves`
- `sketch__addConstraint`, `sketch__addDimension`, `sketch__deleteEntities`,
  `sketch__deleteConstraints`
- solids: `feature__extrude` (new/join/cut, `symmetric`, `direction` reverse,
  `extent` throughAll), `feature__revolve`, `feature__fillet`,
  `feature__chamfer` (EdgeSelector), `feature__shell` (FaceSelector),
  `feature__pattern` (linear/circular bodies), `feature__mirror` (`bodies`
  all/last)
- `feature__import` (STEP text) and `import_step` (a `.step`/`.stp` path)
- `sketch_on_face` — start a sketch on a face by its topological name
  (`face`, preferred: the sketch then follows that face) or the face nearest a
  world point; returns the sketch frame (origin, u, v, normal)

Plus timeline / query / history tools:

- `get_document` — parameters, sketches (with DoF/status), and the timeline
- `describe_sketch` — every entity with **solved coordinates**, constraints, and
  the DoF/conflict diagnosis (use this to decide what to constrain next)
- `list_timeline`, `edit_operation`, `suppress_operation`, `delete_operation`,
  `move_rollback`
- `undo`, `redo`
- `export_document`, `import_document`
- `measure` — exact volume, surface area, centroid and bounds per body, plus
  `between: [a, b]` minimum distance
- `body_topology` — each body's faces (stable names such as `extrude3:end`,
  surface type, area, centre, normal) and edges (`A|B` by the faces they
  separate). Use the names in `sketch_on_face` and fillet/chamfer
  `edges: { names }`
- `batch` — run `steps: [{tool, arguments}]` as one transaction. The first
  failing step rolls the document and its undo history back (`atomic: false`
  keeps the successful steps)

Every tool carries MCP annotations: queries are `readOnlyHint`, and deletes,
`import_document` and `batch` are `destructiveHint`.

## The feedback loop

Every mutating tool returns the **solver diagnosis** for each sketch:

```json
{ "ok": true, "createdIds": ["ln12", "pt10", "pt11"],
  "sketches": [{ "sketch": "sketch6", "dof": 2, "fullyConstrained": false,
                 "conflicting": [], "status": "2 degrees of freedom" }] }
```

If a constraint/dimension would over-constrain a sketch, the call is **rejected**
and returns the conflicting constraint ids, so the agent can self-correct:

```json
{ "ok": false, "error": "Change would over-constrain sketch sketch6",
  "conflicting": ["d28", "d32"] }
```

`export_document` returns the canonical recipe (the operation timeline). Save it
and load it in the browser app, or feed it back with `import_document`.
