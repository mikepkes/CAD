// Assembly expansion: turn parametric *component patterns* + *joint templates*
// into concrete instances, so the rest of the pipeline (FK, geometry, motion)
// never has to know they came from a rule. This is what lets a mechanism be
// duplicated a parametric number of times AND stay jointed — the thing F360
// cannot do: pattern a component and the copies are rigid, with no joints.
//
// The expander is a pure transform: canonical doc in (pattern + templates +
// one source subtree), expanded doc out (N instance subtrees + the joints that
// bind them). The canonical doc is never mutated, so serialization still stores
// only the compact rule; instances are derived, exactly like solved coordinates.
//
// Instance ids are deterministic — `${patternId}#${i}__${localId}` — so a
// selection, the geometry cache, and the motion poser stay stable as the count
// changes. That id scheme is the whole "dynamic joint lookup": a template says
// "self/prev/root + port", and the expander resolves it to a concrete id the
// same way every rebuild.

import { CadDocument, Joint, RoleRef } from "./document";
import { Scope, compileExpr } from "../math/expr";
import { Sketch } from "../sketch/types";

type Vec3 = { x: number; y: number; z: number };

function evalCount(expr: string, scope: Scope, fallback: number): number {
  try { const v = compileExpr(expr).eval(scope); if (Number.isFinite(v)) return Math.max(1, Math.round(v)); } catch { /* fall through */ }
  return Math.max(1, Math.round(fallback));
}

/** Component ids in `root`'s subtree (root included), walked via `children`. */
function collectSubtree(doc: CadDocument, root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !doc.components[id]) continue;
    seen.add(id);
    out.push(id);
    for (const ch of doc.components[id].children) stack.push(ch);
  }
  return out;
}

function cloneSketch(sk: Sketch, id: string, componentId: string | undefined): Sketch {
  return {
    ...sk,
    id,
    componentId,
    plane: undefined, // re-placed from the instance's component world by placeComponentSketches
    entities: JSON.parse(JSON.stringify(sk.entities)),
    constraints: JSON.parse(JSON.stringify(sk.constraints)),
  };
}

/** Replace standalone `i` identifiers (not inside `pi`, `sin`, …) with the index. */
function substituteIndex(expr: string, i: number): string {
  return expr.replace(/\bi\b/g, `(${i})`);
}

/**
 * Expand every component pattern into instances + joints. Returns a NEW doc that
 * shares the canonical entities but adds the instance components/sketches/
 * features/joints and drops the source-template features (so the template itself
 * is not built at the origin). If there are no patterns, the input is returned
 * unchanged. Call `placeComponentSketches` on the result to position instance
 * sketches from the expanded joint graph before building geometry.
 */
export function expandAssembly(doc: CadDocument, scope: Scope): CadDocument {
  const patterns = Object.values(doc.componentPatterns ?? {});
  if (!patterns.length) return doc;

  const components = { ...doc.components };
  const sketches = { ...doc.sketches };
  const features = { ...doc.features };
  const joints = { ...doc.joints };

  for (const p of patterns) {
    const n = evalCount(p.countExpr, scope, p.count);
    p.count = n; // record the resolved count (mirrors how features cache their value)

    const subComps = collectSubtree(doc, p.source);
    const subCompSet = new Set(subComps);
    const subSketches = Object.values(doc.sketches).filter((sk) => sk.componentId && subCompSet.has(sk.componentId));
    const subSketchSet = new Set(subSketches.map((s) => s.id));
    const subFeatures = Object.values(doc.features).filter((f) => "sketchId" in f && subSketchSet.has((f as { sketchId: string }).sketchId));
    const subFeatureSet = new Set(subFeatures.map((f) => f.id));

    // The template subtree is a stand-in; only its instances build.
    for (const f of subFeatures) delete features[f.id];

    const iid = (i: number, localId: string) => `${p.id}#${i}__${localId}`;

    for (let i = 0; i < n; i++) {
      for (const cid of subComps) {
        const c = doc.components[cid];
        components[iid(i, cid)] = {
          ...c,
          id: iid(i, cid),
          parentId: c.parentId && subCompSet.has(c.parentId) ? iid(i, c.parentId) : doc.rootComponentId,
          children: c.children.filter((ch) => subCompSet.has(ch)).map((ch) => iid(i, ch)),
          sketches: c.sketches.filter((s) => subSketchSet.has(s)).map((s) => iid(i, s)),
          connectors: c.connectors ? { ...c.connectors } : undefined,
        };
      }
      for (const sk of subSketches) {
        sketches[iid(i, sk.id)] = cloneSketch(sk, iid(i, sk.id), sk.componentId ? iid(i, sk.componentId) : undefined);
      }
      for (const f of subFeatures) {
        const nf = { ...f, id: iid(i, f.id) } as typeof f & { sketchId?: string; body?: string };
        if ("sketchId" in nf && nf.sketchId) nf.sketchId = iid(i, nf.sketchId);
        if (nf.body && subFeatureSet.has(nf.body)) nf.body = iid(i, nf.body);
        features[iid(i, f.id)] = nf;
      }
    }

    // Stamp the joints. A role ref resolves to a concrete component id + a local
    // connector origin; `prev` of the first instance has no antecedent, so that
    // joint instance is simply skipped.
    const resolveRef = (r: RoleRef, i: number): { comp: string; origin: Vec3 } | null => {
      if (r.role === "root") return { comp: doc.rootComponentId, origin: r.origin ?? { x: 0, y: 0, z: 0 } };
      const idx = r.role === "prev" ? i - 1 : i;
      if (idx < 0 || idx >= n) return null;
      if (!r.component || !subCompSet.has(r.component)) return null;
      const conn = r.port ? doc.components[r.component]?.connectors?.[r.port] : undefined;
      const origin = conn ? conn.origin : (r.origin ?? { x: 0, y: 0, z: 0 });
      return { comp: iid(idx, r.component), origin: { x: origin.x, y: origin.y, z: origin.z } };
    };

    const templates = Object.values(doc.jointTemplates ?? {}).filter((t) => t.patternId === p.id);
    for (const t of templates) {
      for (let i = 0; i < n; i++) {
        if (t.appliesTo === "first" && i !== 0) continue;
        if (t.appliesTo === "rest" && i === 0) continue;
        const base = resolveRef(t.base, i);
        const moved = resolveRef(t.moved, i);
        if (!base || !moved || base.comp === moved.comp) continue;
        const jid = `${t.id}#${i}`;
        const j: Joint = {
          id: jid,
          name: `${t.name} ${i}`,
          kind: t.kind,
          base: base.comp,
          moved: moved.comp,
          baseOrigin: base.origin,
          movedOrigin: moved.origin,
          axis: { x: t.axis.x, y: t.axis.y, z: t.axis.z },
          valueExpr: substituteIndex(t.valueExpr, i),
          valueValue: 0,
        };
        joints[jid] = j;
      }
    }
  }

  return { ...doc, components, sketches, features, joints };
}

/** Whether a doc carries any component pattern (cheap guard for callers). */
export function hasAssemblyPatterns(doc: CadDocument): boolean {
  return Object.keys(doc.componentPatterns ?? {}).length > 0;
}
