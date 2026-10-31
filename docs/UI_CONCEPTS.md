# The concept UI: how it is built

Five ways of working, prototyped on the design canvas, now built into Chisel:

| # | Concept | What it adds | Lives in |
|---|---------|--------------|----------|
| 1 | **Workbench** | Numbered pins on the geometry each feature made; a feature card beside the pin; verbs on a clicked face (Push/Pull, Look at, Measure); a history strip whose rolled-back features stay as ghosts | `src/ui/concepts/workbench/` |
| 2 | **Ledger** | The history read back as sentences with live numbers; hover a sentence ↔ hover the part; design intent checks; the agent's suggestions as tracked changes | `src/ui/concepts/ledger/` |
| 3 | **Design Space** | Two parameters on a map, intents drawn as frontiers, mass shaded, pinned variants compared as ghosts | `src/ui/concepts/space/` |
| 4 | **Lens** | Analysis (zebra, draft, curvature, x-ray, overhang) only under a draggable lens or wipe | `src/ui/concepts/lens/` |
| 5 | **Intent line** | Type what you want (`wall 5`, `front`, `measure`) — every route ends in the same command | `src/ui/concepts/intent/` |

## Tenets

1. **One command path.** Every route — pin, verb, sentence, map, lens, intent line, hotkey, agent, MCP — ends in `useStore.getState().dispatch(...)`, `editOperation`, `moveRollback`, `suppressOperation` or a hotkey action (`hotkeys.runAction`). Nothing talks to `CadSession` or the kernel directly, and nothing keeps its own copy of document state.
2. **Logic in pure modules, components are templates.** Anything with arithmetic or a decision lives in a `.ts` module with no React import, tested in Node (`test/*.test.ts`). A `.tsx` file only maps module output to kit primitives, and gets a behaviour test in jsdom with Testing Library (`test/ui/*.test.tsx`: what it shows, what a click/key/drag sends). If a component needs an `if` about numbers, the `if` belongs in a module.
3. **One catalog of features.** `src/model/concepts/featureCatalog.ts` is the only place that knows a feature kind's label, editable parameters (key, unit, range, step), sentence template and push-param. Pins, cards, the Ledger, the history strip, the verbs and the intent line all read `featureRows(...)` from it. A new feature kind is added there once.
4. **One kit.** `src/ui/kit/` holds the tokens (`kit.css`), the primitives (`Button`, `Pills`, `Card`, `Readout`, `Legend`, `Chip`, `Track`), `LiveNumber`, the projection hooks (`useProjected`, `useViewportRect`, `useViewTick`, `useScene`) and the placement rules (`placeCard`, `clusterPins`). Concepts never restate a colour, a control height or a card placement; they compose. A concept's own CSS (`src/ui/concepts/<name>/<name>.css`) holds only layout for its own elements.
5. **One shared UI state.** `src/model/concepts/uiState.ts` (`useUi`) holds what more than one concept reads: the open feature, the hot (hovered) feature and parameter, which panels are shown. A concept's private state stays in its own module. `store.ts` gains nothing concept-specific except `faceSelection`.
6. **Screen-anchored HTML, not sprites.** Pins, cards, dimensions and HUDs are HTML in `ViewportOverlay`, projected with `useProjected`, which re-runs after each frame the camera moved (`SceneManager.onCameraChange`). The 3D scene only gains what must be in 3D: the lens's second render pass.
7. **Scale with the document.** Pins belong to the active component; other components show one badge each (`clusterPins`), and double-clicking a badge activates that component. Each concept must stay usable on the gyroscope and scissor examples, not only a bracket.
8. **Honest estimates.** Any number shown that is not from the kernel (mass from a density, a deflection estimate) says so in its label or tooltip.

## Plumbing the concepts use

- **Features:** `featureRows(doc, session.timeline, session.rollbackIndex, solids)` → `FeatureRow[]` (num, spec, values, exprs, suppressed, rolledBack, solid, componentId). `pinAnchor(row)` → world point. `sentenceText(row, doc)` for tests and the agent. Edit a param: `useStore.getState().editOperation(row.opId, { ...row.op.params, [key]: String(value) })`.
- **History:** `session.timeline`, `session.rollbackIndex`, `moveRollback(i)`, `suppressOperation(opId, bool)`, `deleteOperation(opId)`. Re-render on `useStore((s) => s.rev)`.
- **Faces:** a model-mode click sets `store.faceSelection: { bodyId, faceName?, point, normal, screen }` (null on empty). Face names follow `src/core/naming.ts` (`"extrude3:end"`, `"hole9:bore"`): the prefix before `:` is the feature id, so a face maps to its feature row. `geometry.topology`/`measure` through the WebMCP host give exact face areas.
- **Views:** `window.dispatchEvent(new CustomEvent("chisel:view", { detail: "front" }))`, `"chisel:frame"`, `"chisel:lookAt"`; or `hotkeys.runAction("view.front")`.
- **Parameters:** `doc.parameters`, `resolveParameters(doc.parameters).scope`, `setParameterExpr(name, expr)`, bounds via `setParameterBounds`.
- **Analysis in 3D:** `store.analysis` / `setAnalysis({ mode })` drives `SceneManager.analysisMaterial` (zebra, draft, curvature). The lens adds a masked second pass in `SceneManager` and an overhang mode.
- **Geometry metrics:** `solids[id].volume`, `.area`, `.bounds`, `.centroid`; material density via `materialForComponent(doc, componentId)`.
- **Agent:** `agentChat` entries; suggestions the Ledger shows come from `src/model/concepts/intents.ts` (pure checks over parameters and metrics) and are applied through the same `dispatch`.

## Layout

`App.tsx` keeps the toolbar, side panels and status bar. The concepts add: pins/cards/verbs/lens inside the viewport overlay (`<Viewport overlays={...}/>`), the history strip docked under the viewport, the Ledger and Design Space as tabs in the right side panel, and the intent line as a palette (`/` or `⌘K`). Each is switchable in `useUi.panels`.

## Checklist for a new piece

- Reads features through `featureRows`; never through `doc.features` directly.
- Uses `Button/Card/Pills/LiveNumber/Readout` and the `k-*` classes; adds no colours.
- Pure logic in a module with a Node test in `test/`; the component with a jsdom test in `test/ui/`.
- Mutates only through the store's command path; adds nothing to `store.ts`.
- Works with 0 features, with a rolled-back history, in sketch mode (hidden or inert), and on a multi-component document.
