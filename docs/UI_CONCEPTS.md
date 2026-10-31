# The concept UI: how it is built

Five ways of working, prototyped on the design canvas, now built into Chisel:

| # | Concept | What it adds | Lives in |
|---|---------|--------------|----------|
| 1 | **Workbench** | Numbered pins on the geometry each feature made; a feature card beside the pin; verbs on a clicked face (Push/Pull, Look at, Measure; the card closes when the history, component or mode changes); a history strip whose rolled-back features stay as ghosts | `src/ui/concepts/workbench/` |
| 2 | **Ledger** | The history read back as sentences with live numbers; hover a sentence ↔ hover the part; design intent checks; the agent's suggestions as tracked changes | `src/ui/concepts/ledger/` |
| 3 | **Design Space** | Two parameters on a map, intents drawn as frontiers, mass shaded, pinned variants compared as ghosts | `src/ui/concepts/space/` |
| 4 | **Lens** | Analysis (zebra, draft, curvature, x-ray, overhang) only under a draggable lens or wipe | `src/ui/concepts/lens/` |
| 5 | **Intent line** | Type what you want (`wall 5`, `front`, `measure`) — every route ends in the same command | `src/ui/concepts/intent/` |

## Tenets

1. **One command path.** Every route — pin, verb, sentence, map, lens, intent line, hotkey, agent, MCP — ends in `useStore.getState().dispatch(...)`, `editOperation`, `moveRollback`, `suppressOperation` or a hotkey action (`hotkeys.runAction`). Nothing talks to `CadSession` or the kernel directly, and nothing keeps its own copy of document state.
2. **Logic in pure modules, components are templates.** Anything with arithmetic or a decision lives in a `.ts` module with no React import, tested in Node (`test/*.test.ts`). A `.tsx` file only maps module output to kit primitives, and gets a behaviour test in jsdom with Testing Library (`test/ui/*.test.tsx`: what it shows, what a click/key/drag sends). If a component needs an `if` about numbers, the `if` belongs in a module.
3. **One catalog of features.** `src/model/concepts/featureCatalog.ts` is the only place that knows a feature kind's label, editable parameters (key, unit, range, step), sentence template and push-param. Pins, cards, the Ledger, the history strip, the verbs and the intent line all read `featureRows(...)` from it. A new feature kind is added there once.
4. **One kit.** `src/ui/kit/` holds the tokens (`kit.css`), the primitives (`Button`, `Pills`, `Card` with its `float | inline | agent` variants, `Readout`, `Legend`, `Chip`, `Track`, `Pin`, `Input`, `Select`), `LiveNumber`, the projection hooks (`useProjected`, `useViewportRect`, `useViewTick`, `useScene`), the placement rules (`placeCard`, `clusterPins`, the `CARD_W*` widths, `useCardSize` to measure a placed card), the one edit throttle (`editQueue.ts`, `useEditQueue` over `store.editOperation`), the one feature-rows hook (`useFeatureRows`, `useActiveComponent`) and the number helpers (`arrowDir`, `formatMagnitude`). Concepts never restate a colour, a control height, a card placement, a throttle or a formatter; they compose. A concept's own CSS (`src/ui/concepts/<name>/<name>.css`) holds only layout for its own elements. The hot (hovered) feature is the kit's `.k-hot` wherever it shows.
5. **One shared UI state.** `src/model/concepts/uiState.ts` (`useUi`) holds what more than one concept reads: the open feature, the hot (hovered) feature and parameter, which panels are shown (the lens included). The design intents themselves are document state (`doc.intents`, built by the `intent.add` / `intent.update` / `intent.delete` timeline operations, so they travel with the file, undo and roll back like a parameter, and the agent and MCP see them); `src/model/concepts/intentsStore.ts` (`useIntents`) is their one evaluation: it follows the document store (session, rev, solids), writes only through `dispatch`, and re-checks every intent in one scope at one density (`densityOf` in `intents.ts`), so the Ledger, the Design Space and the intent line read the same `intents`, `results`, `scope`, `metrics` and `densitySource`. A concept's private state stays in its own module. `store.ts` gains nothing concept-specific except `faceSelection`.
6. **Screen-anchored HTML, not sprites.** Pins, cards, dimensions and HUDs are HTML in `ViewportOverlay`, projected with `useProjected`, which re-runs after each frame the camera moved (`SceneManager.onCameraChange`). The 3D scene only gains what must be in 3D: the lens's second render pass.
7. **Scale with the document.** Pins belong to the active component; other components show one badge each (`clusterPins`), and double-clicking a badge activates that component. Each concept must stay usable on the gyroscope and scissor examples, not only a bracket.
8. **Honest estimates.** Any number shown that is not from the kernel (mass from a density, a deflection estimate) says so in its label or tooltip.

## Plumbing the concepts use

- **Features:** `featureRows(doc, session.timeline, session.rollbackIndex, solids)` → `FeatureRow[]` (num, spec, values, exprs, suppressed, rolledBack, solid, componentId). `pinAnchor(row)` → world point. `sentenceText(row, doc, session.timeline)` for tests and the agent; `nameOf(doc, timeline, id)` names a sketch or feature even once it is rolled back out of the document (from the op that created it). `pushParamFor(row)` is the param a Push/Pull drives (the spec's, else the first the op carries). Edit a param: `useStore.getState().editOperation(row.opId, { ...row.op.params, [key]: String(value) })`.
- **History:** `session.timeline`, `session.rollbackIndex`, `moveRollback(i)`, `suppressOperation(opId, bool)`, `deleteOperation(opId)`. Re-render on `useStore((s) => s.rev)`.
- **Faces:** a model-mode click sets `store.faceSelection: { bodyId, faceName?, point, normal, screen }` (null on empty). Face names follow `src/core/naming.ts` (`"extrude3:end"`, `"hole9:bore"`): the prefix before `:` is the feature id, so a face maps to its feature row. `geometry.topology`/`measure` through the WebMCP host give exact face areas.
- **Views:** `window.dispatchEvent(new CustomEvent("chisel:view", { detail: "front" }))`, `"chisel:frame"`, `"chisel:lookAt"`; or `hotkeys.runAction("view.front")`.
- **Parameters:** `doc.parameters`, `resolveParameters(doc.parameters).scope`, `setParameterExpr(name, expr)`, bounds via `setParameterBounds`.
- **Analysis in 3D:** `store.analysis` / `setAnalysis({ mode })` drives `SceneManager.analysisMaterial` (zebra, draft, curvature). The lens adds a masked second pass in `SceneManager` and an overhang mode. Both passes share their GLSL and `curvatureColors` through `src/viewport/analysisShaders.ts` (the lens hands it a mask); the `--k-an-*` legend tokens in `kit.css` mirror those colours.
- **Geometry metrics:** `solids[id].volume`, `.area`, `.bounds`, `.centroid`; material density via `densityOf(materialForComponent(doc, componentId))` (a density field when the material has one, else a guess from its kind, else aluminium; `source` says which). `unionBounds` / `boundsCentre` / `paramsWith` / `unitLabel` are the catalog's.
- **Agent:** `agentChat` entries; suggestions the Ledger shows come from `src/model/concepts/intents.ts` (pure checks over parameters and metrics) and are applied through the same `dispatch`.

## Layout

`App.tsx` keeps the toolbar, side panels and status bar. The concepts add: pins/cards/verbs/lens inside the viewport overlay (`<Viewport overlays={...}/>`), the history strip docked under the viewport, the Ledger and Design Space as tabs in the right side panel, and the intent line as a palette (`/` or `⌘K`). Each is switchable in `useUi.panels`.

## Checklist for a new piece

- Reads features through `featureRows`; never through `doc.features` directly.
- Uses `Button/Card/Pills/LiveNumber/Readout` and the `k-*` classes; adds no colours.
- Pure logic in a module with a Node test in `test/`; the component with a jsdom test in `test/ui/`.
- Mutates only through the store's command path; adds nothing to `store.ts`.
- Works with 0 features, with a rolled-back history, in sketch mode (hidden or inert), and on a multi-component document.

## Running it

`npm run tauri:dev` (or `npm run dev`) and open a part in model mode.

**Where the pieces are.** `App.tsx` mounts them: `<Viewport overlays={<><WorkbenchOverlay/><LensOverlay/></>}/>` (pins, feature card, face verbs, lens frame + HUD), the `HistoryStrip` docked under the viewport (`.center-dock`, model mode only), the right side panel as tabs Inspector | Ledger | Space (`ConceptShell.tsx`, tab remembered in `useUi.rightTab`), the `IntentLine` palette once, and a `k-panel-toggle` button group at the top-right of the viewport.

**Panel toggles** (`useUi.panels`, persisted in localStorage): Pins (workbench pins, card, verbs and the history strip), Lens, Ledger (adds the tab and selects it), Space (same), and the ⌘K button that opens the intent line. The same switches are hotkey actions `view.workbench`, `view.lens`, `view.ledger`, `view.space` — unbound by default, bindable in the Hotkeys panel — and the intent line understands `ledger`, `space`, `lens`, `workbench`.

**Hotkeys that matter here:** `⌘K` / `Ctrl+K` or `/` opens the intent line (`intent.open`; Escape closes, ↑/↓ choose, Enter runs); `f` frames (model) or looks at the sketch plane (sketch); view names (`front`, `iso`, …) are hotkey actions and intent-line words. Everything the intent line runs is reported in the status bar.

**Shared plumbing added for the concepts:** `store.setMessage(text)` (status line), `store.requestCurvature(on)` (the lens's Curvature mode asks the geometry backend for curvature data while the inspector's analysis mode is off), `SceneManager.lookAtFace(point, normal)` behind `chisel:lookAt` with `detail: { point, normal }` in model mode, `FeatureRow.body` (the body a modifier changed, resolved like the kernel's "most recent body"; pins anchor there), `Chip.onHover/hot`, `LiveNumber` commits the last scrubbed value and keeps the spec it started a drag with, the `--k-an-*` legend tokens that mirror the shader colours, and `.k-overlay > svg { pointer-events: none }` so a full-size SVG layer (leaders, the lens frame) never swallows orbit or pick events.

**The Design Space's sampler backend** (a second kernel) outlives the panel: it is created on first use, forgotten after a failed start so the next run retries, and disposed only when the Space panel is switched off (`disposeSamplerBackend`).

**Known gaps (from the builders' unverified lists; none of this has been looked at in the running app yet):**

- *Rendering:* pin placement over real projections, leader lines over the canvas, card heights (estimated), the range input's look; the Ledger's ghost/struck/hot states and suggestion card; the Design Space SVG in the real panel width; the intent palette's z-order over other overlays.
- *Lens:* the GLSL and GL state (mask against `gl_FragCoord` with the pixel ratio, scissor conversion, depth replacement without speckle, x-ray erase quad, clipping-plane includes) were verified by reading only; the x-ray erases grid/axes inside the lens by design; "on the bed" is the lowest extent of all bodies, so a floating part in an assembly never reads blue; the HUD may shift by one frame when it changes height.
- *Estimates:* mass uses one `densityOf` everywhere (a `density` / `mechanical.density` field when the material has one, else 0.7 / 1.2 / 2.7 g/cm³ by kind, else aluminium), labelled with its source; `Material` still has no density field of its own. Face area in the face verbs is a display-mesh estimate (labelled ≈); the WebMCP `measure` host is not reachable from the store.
- *Design Space:* a second kernel instance shared across mounts (not shared with the motion-study backend); each drag step is one undoable `editOperation`; configured axis parameters are sampled with `configuredBy` stripped; Compare shows deltas, not a ghosted variant.
- *Workbench:* component badges need built solids with bounds; behaviour on the gyroscope/scissor examples is inferred from `clusterPins`, not observed. The x-ray body count includes hidden bodies.
- *Intent line:* `/` as a secondary binding assumes an unshifted slash. (`useIntents` reads the open document itself when the store changes, so an intent added from the line is in the file without the Ledger ever having been shown.)
