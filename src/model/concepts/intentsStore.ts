// The design intents of the open document, as every concept reads them: the
// Ledger lists and edits them, the Design Space draws them, the intent line adds
// to them. The list itself is document state (`session.doc.intents`, built by
// the intent.add / intent.update / intent.delete timeline operations, so it
// travels with the file and undoes, rolls back and rebuilds like a parameter);
// this store is the one evaluation of it. It follows the document store
// (session, rev, solids) and re-checks every intent in the one scope
// (parameters + metrics at the root material's density), so `results` is fresh
// whether or not any panel is mounted. Every write goes through
// `useStore.getState().dispatch(...)` — tenet 1 — one at a time, in order.

import { create } from "zustand";
import type { CadDocument } from "../../core/document";
import type { SolidEval } from "../../core/features";
import { useStore } from "../store";
import { Intent, IntentResult, Metrics, checkIntents, densityOf, evaluateIntents, metricsOf, parseIntent } from "./intents";

let intentSeq = 0;
/** A fresh id unique within the session (time-based so reloads don't collide).
 *  The document allocates real intent ids itself (`intent.add` → createdIds[0]);
 *  this is for callers that need a provisional id before the command has run. */
export function nextIntentId(now = Date.now()): string {
  return `i${now.toString(36)}${(intentSeq++).toString(36)}`;
}

export interface IntentsState {
  /** The document the list belongs to (`session.doc.id`). */
  docId: string | null;
  /** The document's intents (`doc.intents`), as of the last sync or pending edit. */
  intents: Intent[];
  /** Results of the last evaluation, one per intent in the same order. */
  results: IntentResult[];
  /** The scope the results were computed in: every parameter and every metric. */
  scope: Record<string, number>;
  /** The metrics in that scope (bodies 0 when nothing is built). */
  metrics: Metrics;
  /** The density the mass metric used, and where it came from. */
  density: number;
  densitySource: string;
  /** Point the store at `docId`: re-read the open document's intents when it is that one, else show none until it opens. */
  load: (docId: string) => void;
  /** Re-check every intent against the open document and its solids (what the store subscription calls). */
  sync: (doc: CadDocument, solids: Record<string, SolidEval>) => IntentResult[];
  /** Re-check every intent against an arbitrary scope (tests, callers with their own metrics). */
  evaluate: (scope: Record<string, number>) => IntentResult[];
  /** Parse "mass <= 120" (with an optional label) and dispatch intent.add. Null, synchronously, when the
   *  text is not a comparison; else a promise of the intent as the document holds it (null if the command failed). */
  add: (text: string, label?: string) => Promise<Intent | null> | null;
  /** Dispatch intent.delete. */
  remove: (id: string) => Promise<void>;
  /** Dispatch intent.update with `patch`; the list shows the change at once and the command confirms it. */
  update: (id: string, patch: Partial<Omit<Intent, "id">>) => Promise<void>;
}

// Writes run one after another (two concurrent dispatches would each clone the
// same document and the second would drop the first), and while any is pending
// the list keeps the optimistic edit rather than re-reading the document.
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  pending++;
  const p = queue.then(run, run);
  queue = p.then(
    () => { if (--pending === 0) resync(); },
    () => { if (--pending === 0) resync(); }
  );
  return p;
}
function resync() {
  const s = useStore.getState();
  useIntents.getState().sync(s.session.doc, s.solids);
}

export const useIntents = create<IntentsState>((set, get) => {
  const dispatch = (type: string, params: Record<string, unknown>) => useStore.getState().dispatch(type, params);
  return {
    docId: null,
    intents: [],
    results: [],
    scope: {},
    metrics: metricsOf({}),
    density: densityOf(undefined).density,
    densitySource: densityOf(undefined).source,
    load: (docId) => {
      const s = useStore.getState();
      if (s.session.doc.id === docId) get().sync(s.session.doc, s.solids);
      // Another document's intents are only known once it is open: show none until then.
      else set({ docId, intents: [], results: [] });
    },
    sync: (doc, solids) => {
      const { results: fromDoc, scope, metrics, density } = evaluateIntents(doc, solids);
      // Keep an optimistic edit on screen until its command has landed; the doc has the truth after that.
      const intents = pending > 0 && get().docId === doc.id ? get().intents : doc.intents ?? [];
      const results = pending > 0 && get().docId === doc.id ? checkIntents(intents, scope) : fromDoc;
      set({ docId: doc.id, intents, scope, metrics, density: density.density, densitySource: density.source, results });
      return results;
    },
    evaluate: (scope) => {
      const results = checkIntents(get().intents, scope);
      set({ scope, results });
      return results;
    },
    add: (text, label) => {
      const trimmed = label?.trim();
      const parsed = parseIntent(text, "", trimmed || undefined);
      if (!parsed) return null;
      return enqueue(async () => {
        const r = await dispatch("intent.add", { label: parsed.label, lhs: parsed.lhs, op: parsed.op, rhs: parsed.rhs });
        if (!r.ok) return null;
        const id = r.createdIds[0];
        return useStore.getState().session.doc.intents.find((i) => i.id === id) ?? null;
      });
    },
    remove: (id) => {
      set({ intents: get().intents.filter((i) => i.id !== id), results: get().results.filter((r) => r.intent.id !== id) });
      return enqueue(async () => { await dispatch("intent.delete", { id }); });
    },
    update: (id, patch) => {
      const intents = get().intents.map((i) => (i.id === id ? { ...i, ...patch } : i));
      set({ intents, results: checkIntents(intents, get().scope) });
      const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      return enqueue(async () => { await dispatch("intent.update", { id, ...fields }); });
    },
  };
});

// Follow the document: whenever the session, its revision or the built solids
// change, re-evaluate once for everyone.
useStore.subscribe((s, prev) => {
  if (s.session !== prev.session || s.rev !== prev.rev || s.solids !== prev.solids) useIntents.getState().sync(s.session.doc, s.solids);
});

/** Hook: the current results (one per intent). */
export const useIntentResults = () => useIntents((s) => s.results);
/** Hook: the scope the results were checked in. */
export const useIntentScope = () => useIntents((s) => s.scope);
