// Independent chains of features: the split that lets a pool of geometry workers build a
// model's bodies in parallel.
//
// A feature reads some bodies (the one it cuts, fillets, holes…) and may make one. Two
// features that touch the same body must run in order, in one kernel; features that never
// share a body can run in different kernels at once. This walks the active features in
// timeline order, predicting — without the kernel — which body each one reads and makes
// (the same rules as features.ts: a boolean's `body`, or the most recent body when it
// names none), and joins the features that share a body into a chain. The result is
// exact for the feature kinds listed below; anything else (a feature that reads every
// body, like a mirror of all of them or a sketch on a face; a sheet-metal or weldment
// step; an assembly pattern) makes the split unsafe, and null says so: build it whole.
//
// The chain of a body-making feature is named by that feature's id, so the same chain
// goes to the same worker evaluation after evaluation and its incremental cache hits.

import type { CadDocument, FeatureDef } from "../document";
import type { Scope } from "../../math/expr";
import { featureActive } from "../features";
import { hasAssemblyPatterns } from "../assembly";

export interface FeatureChain {
  /** The id of the chain's first feature (the body it starts). */
  id: string;
  /** The chain's features, in timeline order. */
  features: string[];
}

/** The chains of `doc`'s active features, or null when they can't be told apart safely. */
export function featureChains(doc: CadDocument, scope: Scope): FeatureChain[] | null {
  if (hasAssemblyPatterns(doc)) return null;
  const features = Object.values(doc.features).filter((f) => featureActive(f, scope));
  // union-find over chain roots: every feature starts as its own chain
  const parent = features.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  // the bodies built so far: id and the chain (feature index) that owns it
  const bodies: { id: string; chain: number }[] = [];
  const last = () => bodies[bodies.length - 1];
  const named = (ref: string | undefined) => (!ref || ref === "last" ? last() : bodies.find((b) => b.id === ref));
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (f.instanceFrame) return null;
    const effect = featureEffect(doc, f, bodies.length > 0, named);
    if (!effect) return null;
    for (const b of effect.reads) union(i, b.chain);
    if (effect.makes) bodies.push({ id: f.id, chain: i });
    for (const b of effect.removes ?? []) bodies.splice(bodies.indexOf(b), 1);
  }
  const chains = new Map<number, FeatureChain>();
  for (let i = 0; i < features.length; i++) {
    const root = find(i);
    const c = chains.get(root);
    if (c) c.features.push(features[i].id);
    else chains.set(root, { id: features[i].id, features: [features[i].id] });
  }
  return [...chains.values()];
}

type SimBody = { id: string; chain: number };
interface Effect { reads: SimBody[]; makes: boolean; removes?: SimBody[] }

/** What a feature does to the body list, or null for a kind this can't predict. */
function featureEffect(doc: CadDocument, f: FeatureDef, any: boolean, named: (ref: string | undefined) => SimBody | undefined): Effect | null {
  const some = (...bs: (SimBody | undefined)[]) => bs.filter((b): b is SimBody => !!b);
  const op = "operation" in f ? (f.operation ?? "new") : "new";
  const target = () => named("body" in f ? (f.body as string | undefined) : undefined);
  switch (f.kind) {
    case "extrude": case "revolve":
      if (doc.sketches[f.sketchId]?.faceRef) return null; // re-resolves its plane against every body
      if (f.kind === "extrude" && f.extent === "toFace") return null; // finds its face on any body
      return op === "new" || !any ? { reads: [], makes: true } : { reads: some(target()), makes: false };
    case "primitive": case "import": case "loft": case "sweep": case "gear":
      return op === "new" || !any ? { reads: [], makes: true } : { reads: some(target()), makes: false };
    case "thread":
      // an external thread with nothing to join is a body of its own; an internal one cuts its target
      if (!f.spec.internal && (op === "new" || !any)) return { reads: [], makes: true };
      return { reads: some(target()), makes: false };
    case "hole": case "fillet": case "chamfer": case "shell": case "draft": case "pattern": case "voronoi":
      return { reads: some(target()), makes: false };
    case "mirror":
      return f.bodies === "last" ? { reads: some(named("last")), makes: false } : null; // else every body
    case "trim":
      return { reads: some(target(), f.toolBody ? named(f.toolBody) : undefined), makes: false };
    case "stitch": {
      const parts = f.bodies.map((id) => named(id));
      const found = some(...parts);
      // sews them into the first (the rest are consumed) — when every one is there
      return { reads: found, makes: false, removes: found.length === parts.length && found.length >= 2 ? found.slice(1) : [] };
    }
    default:
      return null; // member, surface, sheet (and its folds), thicken, untrim: built whole
  }
}

/** Where each feature's row sits in a whole evaluation's `solids` (its position in the
 *  timeline), for putting the rows of separately built chains back in that order. */
export function featureOrder(doc: CadDocument): Map<string, number> {
  const order = new Map<string, number>();
  Object.keys(doc.features).forEach((id, i) => order.set(id, i));
  return order;
}
