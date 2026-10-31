// The design intents of the open document, as every concept reads them: the
// Ledger lists and edits them, the Design Space draws them, the intent line adds
// to them. One zustand store, loaded per document id and saved on every change
// (loadIntents / saveIntents), and one evaluation: the store follows the
// document store (session, rev, solids) and re-checks every intent in the one
// scope (parameters + metrics at the root material's density), so `results` is
// fresh whether or not any panel is mounted.

import { create } from "zustand";
import { materialForComponent, type CadDocument } from "../../core/document";
import type { SolidEval } from "../../core/features";
import { useStore } from "../store";
import { Intent, IntentResult, Metrics, checkIntents, densityOf, intentScope, loadIntents, metricsOf, parseIntent, saveIntents } from "./intents";

let intentSeq = 0;
/** A fresh intent id, unique within the session (time-based so reloads don't collide). */
export function nextIntentId(now = Date.now()): string {
  return `i${now.toString(36)}${(intentSeq++).toString(36)}`;
}

export interface IntentsState {
  /** The document the list belongs to (intents are kept per document id). */
  docId: string | null;
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
  /** Switch to (and load) a document's intents; a no-op for the current document. */
  load: (docId: string) => void;
  /** Re-check every intent against the open document and its solids (what the store subscription calls). */
  sync: (doc: CadDocument, solids: Record<string, SolidEval>) => IntentResult[];
  /** Re-check every intent against an arbitrary scope (tests, callers with their own metrics). */
  evaluate: (scope: Record<string, number>) => IntentResult[];
  /** Parse "mass <= 120" (with an optional label) and add it; null when the text is not a comparison. */
  add: (text: string, label?: string) => Intent | null;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<Intent, "id">>) => void;
}

export const useIntents = create<IntentsState>((set, get) => {
  const put = (intents: Intent[]) => {
    const { docId, scope } = get();
    if (docId) saveIntents(docId, intents);
    set({ intents, results: checkIntents(intents, scope) });
  };
  return {
    docId: null,
    intents: [],
    results: [],
    scope: {},
    metrics: metricsOf({}),
    density: densityOf(undefined).density,
    densitySource: densityOf(undefined).source,
    load: (docId) => {
      if (get().docId === docId) return;
      const intents = loadIntents(docId);
      set({ docId, intents, results: checkIntents(intents, get().scope) });
    },
    sync: (doc, solids) => {
      get().load(doc.id);
      const { density, source } = densityOf(materialForComponent(doc, doc.rootComponentId));
      const metrics = metricsOf(solids, density);
      const scope = intentScope(doc, metrics);
      const results = checkIntents(get().intents, scope);
      set({ scope, metrics, density, densitySource: source, results });
      return results;
    },
    evaluate: (scope) => {
      const results = checkIntents(get().intents, scope);
      set({ scope, results });
      return results;
    },
    add: (text, label) => {
      const trimmed = label?.trim();
      const intent = parseIntent(text, nextIntentId(), trimmed || undefined);
      if (!intent) return null;
      put([...get().intents, intent]);
      return intent;
    },
    remove: (id) => put(get().intents.filter((i) => i.id !== id)),
    update: (id, patch) => put(get().intents.map((i) => (i.id === id ? { ...i, ...patch } : i))),
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
