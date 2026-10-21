# Chisel CAD — MCP server

An MCP server that exposes the Chisel CAD core to an LLM/agent. The core runs
headless here (PlaneGCS via WebAssembly), so an agent can build and edit
parametric, CNC/3D-print-ready models with no browser.

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
- `sketch__create`, `sketch__addPoint`, `sketch__addLine`, `sketch__addCircle`,
  `sketch__addRectangle`
- `sketch__addConstraint`, `sketch__addDimension`, `sketch__deleteEntities`

Plus timeline / query / history tools:

- `get_document` — parameters, sketches (with DoF/status), and the timeline
- `describe_sketch` — every entity with **solved coordinates**, constraints, and
  the DoF/conflict diagnosis (use this to decide what to constrain next)
- `list_timeline`, `edit_operation`, `suppress_operation`, `delete_operation`,
  `move_rollback`
- `undo`, `redo`
- `export_document`, `import_document`

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
