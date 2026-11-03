// The demo's display-only looks over posed parts (poseSweep): an exploded view, and parts drawn see-through so what's
// inside them shows. Nothing here touches the document: parts are picked by component name, and an explode only
// shifts where a component is drawn.

import type { CadDocument } from "../core/document";
import { compose, translation, type Rigid } from "../math/transform";
import type { Vec3 } from "../math/vec";

/** Does `name` match `pattern`: exactly, or by its start when the pattern ends in "*" ("Pivot pin*"). */
export const nameMatches = (pattern: string, name: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

/** The ids of the components named in `names` (patterns as nameMatches), and everything under them. */
export function componentsNamed(doc: CadDocument, names: string[]): Set<string> {
  const ids = new Set<string>();
  const add = (id: string) => { if (ids.has(id)) return; ids.add(id); for (const c of doc.components[id]?.children ?? []) add(c); };
  for (const c of Object.values(doc.components)) if (names.some((n) => nameMatches(n, c.name))) add(c.id);
  return ids;
}

/** Each component's offset in an exploded view, from offsets given by component name (patterns as nameMatches): a
 *  component takes its own, or else its nearest named ancestor's, so a part's pins and sub-parts travel with it unless
 *  they're named too. Components with no named ancestor stay where they are. */
export function explodeOffsets(doc: CadDocument, spec: Record<string, [number, number, number]>): Map<string, Vec3> {
  const own = (name: string) => { const k = Object.keys(spec).find((p) => nameMatches(p, name)); return k ? spec[k] : null; };
  const out = new Map<string, Vec3>();
  for (const c of Object.values(doc.components)) {
    for (let at: string | null = c.id; at; at = doc.components[at]?.parentId ?? null) {
      const o = doc.components[at] && own(doc.components[at].name);
      if (o) { out.set(c.id, { x: o[0], y: o[1], z: o[2] }); break; }
    }
  }
  return out;
}

/** The posed world frames with the explode applied `k` of the way (0 as posed, 1 fully apart): each offset component
 *  slides along its offset, in world space, keeping its pose. */
export function exploded(world: Map<string, Rigid>, offsets: Map<string, Vec3>, k: number): Map<string, Rigid> {
  if (!k || !offsets.size) return world;
  const out = new Map(world);
  for (const [cid, o] of offsets) {
    const W = world.get(cid);
    if (W) out.set(cid, compose(translation({ x: o.x * k, y: o.y * k, z: o.z * k }), W));
  }
  return out;
}
