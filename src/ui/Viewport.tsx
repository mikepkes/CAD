import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SceneManager, ViewData } from "../viewport/SceneManager";
import { Interactions } from "../viewport/interactions";
import { setActiveScene } from "../viewport/sceneRef";
import { AppState, useStore } from "../model/store";
import { resolveSketchPlane, to3d } from "../geometry/plane";
import { extractRegions, loopPolygon, Region } from "../core/geometry/profile";
import { resolveParameters } from "../model/parameters";
import { compileExpr } from "../math/expr";
import { materialForComponent } from "../core/document";
import { woodFrameFromBounds } from "../viewport/material";
import { ContextMenu } from "./ContextMenu";

function pointInPoly(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function inRegion(p: { x: number; y: number }, r: Region): boolean {
  return pointInPoly(p, loopPolygon(r.outer)) && !r.holes.some((h) => pointInPoly(p, loopPolygon(h)));
}

/** Regions of the extrude target chosen by the current pick (one region, or all). */
function chosenRegions(s: AppState): { plane: ReturnType<typeof resolveSketchPlane>; regions: Region[] } | null {
  if (!s.extrudeActive || !s.extrudeTarget) return null;
  const sk = s.session.doc.sketches[s.extrudeTarget];
  if (!sk) return null;
  const all = extractRegions(sk);
  const chosen = s.extrudeRegion ? all.filter((r) => inRegion(s.extrudeRegion!, r)) : all;
  if (!chosen.length) return null;
  return { plane: resolveSketchPlane(sk), regions: chosen };
}

function evalDistance(expr: string, s: AppState): number {
  const { scope } = resolveParameters(s.session.doc.parameters);
  try { const v = compileExpr(expr).eval(scope); if (Number.isFinite(v)) return v; } catch { /* fall through */ }
  const f = parseFloat(expr);
  return Number.isFinite(f) ? f : 10;
}

/** Install/clear the extrude distance drag handle for the current session. */
function updateExtrudeHandle(scene: SceneManager, s: AppState) {
  const ctx = chosenRegions(s);
  if (!ctx) { scene.handles.clear(); return; }
  let au = 0, av = 0;
  for (const r of ctx.regions) { au += r.interior.x; av += r.interior.y; }
  au /= ctx.regions.length; av /= ctx.regions.length;
  const anchor = to3d(ctx.plane, au, av);
  scene.handles.set([{
    id: "extrude-distance",
    anchor,
    dir: ctx.plane.normal,
    value: evalDistance(s.extrudeDistanceExpr, s),
    color: s.extrudeOperation === "cut" ? 0xe4564e : 0x5bbf84,
    onChange: (v) => useStore.getState().setExtrudeDistanceExpr(String(Math.round(v * 100) / 100)),
  }]);
}

function buildView(s: AppState): ViewData {
  const sketch = s.renderSketch();
  // Every sketch except the active one stays visible, dimmed, on its own plane.
  const ghostSketches = Object.values(s.session.doc.sketches)
    .filter((sk) => sk.id !== s.activeSketchId)
    .map((sk) => ({ sketch: sk, plane: resolveSketchPlane(sk) }));
  const datumPlanes = Object.values(s.session.doc.planes)
    .filter((d) => d.plane)
    .map((d) => ({ id: d.id, name: d.name, plane: d.plane! }));
  const doc = s.session.doc;
  const solids = Object.values(s.solids)
    .filter((sol) => sol.mesh)
    .map((sol) => {
      // Resolve the body's material from its owning component (bodies inherit;
      // instance bodies keep their source sketch id, so this resolves for them too).
      const comp = sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined;
      const mat = materialForComponent(doc, comp);
      const material = mat ? { kind: mat.kind, species: mat.species, finish: mat.finish, color: mat.color, roughness: mat.roughness, metalness: mat.metalness, ringScale: mat.ringScale, grainContrast: mat.grainContrast, poreStrength: mat.poreStrength } : undefined;
      const woodFrame = material?.kind === "wood" && sol.bounds ? woodFrameFromBounds(sol.bounds, sol.featureId) : undefined;
      return {
        id: sol.featureId,
        positions: sol.mesh!.positions,
        normals: sol.mesh!.normals,
        indices: sol.mesh!.indices,
        edges: sol.mesh!.edges,
        threadDecals: sol.threadDecals,
        material,
        woodFrame,
      };
    });
  return {
    mode: s.mode,
    planeId: sketch ? sketch.planeId : null,
    plane: sketch ? resolveSketchPlane(sketch) : null,
    sketch,
    selection: new Set(s.selection),
    hover: s.hover,
    preview: null,
    showPlanes: s.showPlanes,
    showGrid: s.showGrid,
    gridSize: s.gridSize,
    showConstraints: s.showConstraints,
    constraintState: !sketch
      ? "under"
      : sketch.status.conflicting
        ? "conflict"
        : sketch.status.fullyConstrained
          ? "full"
          : "under",
    solids,
    ghostSketches,
    datumPlanes,
    extrudeRegions: buildExtrudeRegions(s),
    extrudePreview: buildExtrudePreview(s),
    section: s.section,
  };
}

function buildExtrudePreview(s: AppState): ViewData["extrudePreview"] {
  const ctx = chosenRegions(s);
  if (!ctx) return undefined;
  const distance = evalDistance(s.extrudeDistanceExpr, s);
  if (Math.abs(distance) < 1e-6) return undefined;
  return {
    plane: ctx.plane,
    regions: ctx.regions.map((r) => ({ outer: loopPolygon(r.outer), holes: r.holes.map(loopPolygon) })),
    distance,
    symmetric: s.extrudeSymmetric,
    operation: s.extrudeOperation,
  };
}

function buildExtrudeRegions(s: AppState): ViewData["extrudeRegions"] {
  if (!s.extrudeActive || !s.extrudeTarget) return undefined;
  const sk = s.session.doc.sketches[s.extrudeTarget];
  if (!sk) return undefined;
  const sel = s.extrudeRegion;
  const regions = extractRegions(sk).map((r) => {
    const outer = loopPolygon(r.outer);
    const holes = r.holes.map(loopPolygon);
    const selected = sel ? pointInPoly(sel, outer) && !holes.some((h) => pointInPoly(sel, h)) : true;
    return { interior: r.interior, outer, holes, selected };
  });
  if (!regions.length) return undefined;
  return { plane: resolveSketchPlane(sk), regions };
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const scene = new SceneManager(container);
    const controller = new Interactions(scene, scene.renderer.domElement);
    setActiveScene(scene);
    if (import.meta.env?.DEV) (window as unknown as { __scene?: unknown }).__scene = scene;

    let prevMode = useStore.getState().mode;
    let prevSketch = useStore.getState().activeSketchId;

    controller.configureControls(scene.controls, prevMode);
    controller.setBase(buildView(useStore.getState()));
    updateExtrudeHandle(scene, useStore.getState());

    const unsub = useStore.subscribe((s) => {
      controller.setBase(buildView(s));
      updateExtrudeHandle(scene, s);
      if (s.mode !== prevMode) {
        controller.configureControls(scene.controls, s.mode);
        if (s.mode === "model") scene.exitSketchView();
        prevMode = s.mode;
      }
      if (s.mode === "sketch" && s.activeSketchId && s.activeSketchId !== prevSketch) {
        const sk = s.session.doc.sketches[s.activeSketchId];
        if (sk) scene.transitionToSketchView(resolveSketchPlane(sk));
      }
      prevSketch = s.activeSketchId;
    });

    return () => {
      unsub();
      setActiveScene(null);
      controller.dispose();
      scene.dispose();
    };
  }, []);

  return (
    <div className="viewport" ref={containerRef}>
      <InlineDimensionEditor />
      <ContextMenu />
    </div>
  );
}

/** Small floating input for placing a new dimension or editing one in place. */
function InlineDimensionEditor() {
  const edit = useStore((s) => s.inlineEdit);
  const commit = useStore((s) => s.commitInlineEdit);
  const cancel = useStore((s) => s.cancelInlineEdit);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const done = useRef(false);

  useLayoutEffect(() => {
    if (edit) {
      setValue(edit.value);
      done.current = false;
      // focus + select after the element mounts
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    }
  }, [edit]);

  if (!edit) return null;

  const finish = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    if (ok) void commit(value); else cancel();
  };

  return (
    <input
      ref={inputRef}
      className="inline-dim"
      value={value}
      style={{ left: edit.screen.x + 10, top: edit.screen.y - 12 }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        e.stopPropagation();
      }}
      onBlur={() => finish(true)}
      placeholder="value or expr"
    />
  );
}
