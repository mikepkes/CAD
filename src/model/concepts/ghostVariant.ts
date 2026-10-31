// A design variant shown as a ghost on the part: the solids of another version
// of the document (the Design Space's compared pin today), drawn by the
// viewport as translucent, dashed, unpickable bodies beside the real ones.
// Lives here because two concepts touch it: the Design Space writes it, the
// viewport reads it (tenet 5). Evaluating the variant is the writer's job; this
// slice only holds the result, and forgets it when the document changes.

import { create } from "zustand";
import type { SolidEval } from "../../core/features";
import type { SolidView } from "../../viewport/SceneManager";
import { useStore } from "../store";

export interface GhostState {
  /** The variant's built bodies, or null when no ghost is shown. */
  solids: SolidEval[] | null;
  /** What the ghost is ("Pin A: w 20 · h 5"), for tooltips and the status line. */
  label: string | null;
  /** The id of the document the ghost belongs to; a view of a document with another id never draws it (ids can repeat, so the session swap above is what really clears it). */
  docId: string | null;
  set: (solids: SolidEval[], label: string, docId: string) => void;
  clear: () => void;
}

export const useGhost = create<GhostState>((set, get) => ({
  solids: null,
  label: null,
  docId: null,
  set: (solids, label, docId) => set({ solids, label, docId }),
  clear: () => { if (get().solids !== null || get().label !== null) set({ solids: null, label: null, docId: null }); },
}));

/** The ghost's bodies as viewport entries: ghost (faint, unpickable) and variant (the kit's ghost accent, dashed). */
export function ghostSolidViews(ghost: Pick<GhostState, "solids" | "docId">, docId: string, visible: (s: SolidEval) => boolean = () => true): SolidView[] {
  if (!ghost.solids || ghost.docId !== docId) return [];
  return ghost.solids
    .filter((sol) => sol.mesh && visible(sol))
    .map((sol) => ({
      // No `id`: a ghost is never picked, and the real body of the same feature keeps its material cache key.
      positions: sol.mesh!.positions,
      normals: sol.mesh!.normals,
      indices: sol.mesh!.indices,
      edges: sol.mesh!.edges,
      ghost: true,
      variant: true,
    }));
}

// Switching documents forgets the ghost: a variant of one document means nothing on another.
// A new document is a new CadSession in the store (loadDocument, or an undo across a load);
// the document id alone is not enough, since every new document is "doc1" until it is saved as something else.
useStore.subscribe((s, prev) => {
  if (s.session !== prev.session) useGhost.getState().clear();
});
