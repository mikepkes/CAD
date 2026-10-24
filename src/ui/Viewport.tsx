import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SceneManager, ViewData } from "../viewport/SceneManager";
import { Interactions } from "../viewport/interactions";
import { AppState, useStore } from "../model/store";
import { resolveSketchPlane } from "../geometry/plane";
import { ContextMenu } from "./ContextMenu";

function buildView(s: AppState): ViewData {
  const sketch = s.renderSketch();
  // Every sketch except the active one stays visible, dimmed, on its own plane.
  const ghostSketches = Object.values(s.session.doc.sketches)
    .filter((sk) => sk.id !== s.activeSketchId)
    .map((sk) => ({ sketch: sk, plane: resolveSketchPlane(sk) }));
  const solids = Object.values(s.solids)
    .filter((sol) => sol.mesh)
    .map((sol) => ({
      positions: sol.mesh!.positions,
      normals: sol.mesh!.normals,
      indices: sol.mesh!.indices,
      edges: sol.mesh!.edges,
    }));
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
  };
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const scene = new SceneManager(container);
    const controller = new Interactions(scene, scene.renderer.domElement);
    if (import.meta.env?.DEV) (window as unknown as { __scene?: unknown }).__scene = scene;

    let prevMode = useStore.getState().mode;
    let prevSketch = useStore.getState().activeSketchId;

    controller.configureControls(scene.controls, prevMode);
    controller.setBase(buildView(useStore.getState()));

    const unsub = useStore.subscribe((s) => {
      controller.setBase(buildView(s));
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
