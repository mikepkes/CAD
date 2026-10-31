// One edit in flight per component, through store.editOperation. The feature
// card, the face verbs and the Ledger's sentences all scrub through this.

import { useMemo } from "react";
import { useStore } from "../../model/store";
import { createEditQueue } from "./editQueue";

export interface Edit { opId: string; params: Record<string, unknown> }
export const editKey = (e: Edit) => e.opId + JSON.stringify(e.params);

export interface OpEditQueue {
  /** A value while scrubbing. */
  live: (opId: string, params: Record<string, unknown>) => void;
  /** The value on release / Enter / arrow key: skipped when it is the one already sent. */
  commit: (opId: string, params: Record<string, unknown>) => void;
}

/** The store's editOperation behind a one-in-flight queue (the store is read at call time, so a swapped action is honoured). */
export function useEditQueue(): OpEditQueue {
  return useMemo(() => {
    const q = createEditQueue<Edit>((e) => useStore.getState().editOperation(e.opId, e.params), editKey);
    return { live: (opId, params) => q.live({ opId, params }), commit: (opId, params) => q.commit({ opId, params }) };
  }, []);
}
