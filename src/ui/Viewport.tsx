import { useEffect, useRef } from "react";
import { SceneManager, ViewData } from "../viewport/SceneManager";
import { Interactions } from "../viewport/interactions";
import { AppState, useStore } from "../model/store";

function buildView(s: AppState): ViewData {
  const sketch = s.renderSketch();
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
  };
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const scene = new SceneManager(container);
    const controller = new Interactions(scene, scene.renderer.domElement);

    let prevMode = useStore.getState().mode;
    let prevSketch = useStore.getState().activeSketchId;

    controller.configureControls(scene.controls, prevMode);
    controller.setBase(buildView(useStore.getState()));

    const unsub = useStore.subscribe((s) => {
      controller.setBase(buildView(s));
      if (s.mode !== prevMode) {
        controller.configureControls(scene.controls, s.mode);
        prevMode = s.mode;
      }
      if (s.mode === "sketch" && s.activeSketchId && s.activeSketchId !== prevSketch) {
        const sk = s.session.doc.sketches[s.activeSketchId];
        if (sk) scene.focusPlane(sk.planeId);
      }
      prevSketch = s.activeSketchId;
    });

    return () => {
      unsub();
      controller.dispose();
      scene.dispose();
    };
  }, []);

  return <div className="viewport" ref={containerRef} />;
}
