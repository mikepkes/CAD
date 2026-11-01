// Lights what is selected on the model (M10): the face the face card is open on,
// Shell's faces to open, and the edges an edge-pick Fillet/Chamfer holds. Draws
// nothing itself; it keeps the scene's selection layer in step with the store.

import { useEffect } from "react";
import { useStore, type AppState } from "../model/store";
import { getActiveScene, onActiveScene } from "../viewport/sceneRef";
import { faceTriangles } from "../model/pickMenu";
import { edgeSegments } from "../model/edgePick";

type Part = { bodyId?: string; faces?: Float32Array | null; edges?: Float32Array | null };

/** The selection layer's parts for a store state. */
export function selectionParts(s: Pick<AppState, "faceSelection" | "featureTool" | "solids" | "mode">): Part[] {
  if (s.mode !== "model") return [];
  const mesh = (id: string | null | undefined) => (id ? s.solids[id]?.mesh : undefined);
  const t = s.featureTool;
  if (t?.kind === "shell" && t.body) return t.faces.map((f) => ({ bodyId: t.body!, faces: faceTriangles(mesh(t.body), f.name) }));
  if (t?.kind === "edges" && t.body) { const m = mesh(t.body); return m ? [{ bodyId: t.body, edges: edgeSegments(m, t.edges) }] : []; }
  const f = s.faceSelection;
  if (f?.faceName && !t) return [{ bodyId: f.bodyId, faces: faceTriangles(mesh(f.bodyId), f.faceName) }];
  return [];
}

export function SelectionHighlight() {
  useEffect(() => {
    let last: unknown[] = [];
    const sync = () => {
      const s = useStore.getState();
      const key = [s.faceSelection, s.featureTool, s.solids, s.mode, getActiveScene()];
      if (key.every((k, i) => k === last[i])) return;
      last = key;
      getActiveScene()?.setSelectionHighlight(selectionParts(s));
    };
    sync();
    const off1 = useStore.subscribe(sync);
    const off2 = onActiveScene(() => sync());
    return () => { off1(); off2(); getActiveScene()?.setSelectionHighlight(null); };
  }, []);
  return null;
}
