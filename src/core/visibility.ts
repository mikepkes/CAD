// Visibility: what the viewport draws. Display-only document state — a hidden
// body still exists for booleans, measurement, collisions and export (removing
// geometry is what suppression is for). Bodies, sketches, components and datum
// planes are hidden by id; hiding a component hides everything in it. The
// active configuration may hide more on top of the document's own list.

import type { CadDocument } from "./document";

/** Everything hidden right now: the document's list plus the active configuration's. */
export function hiddenIds(doc: CadDocument): Set<string> {
  const out = new Set(doc.hidden ?? []);
  const cfg = doc.configurations?.find((c) => c.id === doc.activeConfiguration);
  for (const id of cfg?.hide ?? []) out.add(id);
  return out;
}

/** Whether a component, or any component above it, is hidden. */
export function componentHidden(doc: CadDocument, componentId: string | undefined, hidden: Set<string>): boolean {
  const seen = new Set<string>();
  for (let id = componentId; id && !seen.has(id); id = doc.components[id]?.parentId ?? undefined) {
    seen.add(id);
    if (hidden.has(id)) return true;
  }
  return false;
}

/** The component a body belongs to: its sketch's, else the root (primitives, imports). */
export const bodyComponent = (doc: CadDocument, body: { sketchId?: string }): string =>
  (body.sketchId && doc.sketches[body.sketchId]?.componentId) || doc.rootComponentId;

/** Whether a body (by its creating feature id + sketch) is drawn. */
export function bodyVisible(doc: CadDocument, body: { featureId: string; sketchId?: string }, hidden = hiddenIds(doc)): boolean {
  return !hidden.has(body.featureId) && !componentHidden(doc, bodyComponent(doc, body), hidden);
}

/** Whether a sketch is drawn. */
export function sketchVisible(doc: CadDocument, sketchId: string, hidden = hiddenIds(doc)): boolean {
  const sk = doc.sketches[sketchId];
  return !!sk && !hidden.has(sketchId) && !componentHidden(doc, sk.componentId, hidden);
}

/** Ids that can be hidden: features (bodies), sketches, components, datum planes. */
export function isHideable(doc: CadDocument, id: string): boolean {
  return !!(doc.features[id] || doc.sketches[id] || doc.components[id] || doc.planes[id]);
}

/**
 * The hidden list that shows only `ids`: every other body and sketch is
 * hidden, except what lives inside a kept component. Throws on an id that
 * names nothing hideable.
 */
export function isolationList(doc: CadDocument, bodies: { featureId: string; sketchId?: string }[], ids: string[]): string[] {
  const unknown = ids.filter((id) => !isHideable(doc, id));
  if (unknown.length) throw new Error(`Nothing called ${unknown.map((u) => `"${u}"`).join(", ")}`);
  const keep = new Set(ids);
  const kept = (id: string, comp: string | undefined) => keep.has(id) || componentHidden(doc, comp, keep);
  return [
    ...bodies.filter((b) => !kept(b.featureId, bodyComponent(doc, b))).map((b) => b.featureId),
    ...Object.values(doc.sketches).filter((sk) => !kept(sk.id, sk.componentId)).map((sk) => sk.id),
  ];
}
