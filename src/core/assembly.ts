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

import { CadDocument, Connector, FeatureDef, Joint, RoleRef, SketchFeature } from "./document";
import { Scope, compileExpr } from "../math/expr";
import { Sketch } from "../sketch/types";
import { Rigid, IDENTITY, compose, invert, applyPoint, applyVec } from "../math/transform";
import { resolveComponentWorld } from "./recompute";
import type { SolidEval } from "./features";
import type { SolidMesh, Bounds3 } from "./occ/kernel";

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
  // A custom plane IS the sketch's placement (in world space), so keep it as the
  // template the instance is placed from rather than dropping it.
  const custom = sk.planeId === "custom" && sk.plane && sk.componentId;
  return {
    ...sk,
    id,
    componentId,
    plane: undefined, // re-placed from the instance's component world by placeComponentSketches
    ...(custom ? { templatePlane: { plane: sk.plane!, componentId: sk.componentId! } } : {}),
    entities: JSON.parse(JSON.stringify(sk.entities)),
    constraints: JSON.parse(JSON.stringify(sk.constraints)),
  };
}

/** The body each feature starts (its own id) or acts on, replaying evaluateBodies'
 *  rule: a solid-making feature with operation "new" — or the very first body —
 *  starts one; anything else modifies its explicit `body`, else the most recent. */
function featureBodies(doc: CadDocument): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  let last: string | undefined;
  for (const f of Object.values(doc.features)) {
    const op = "operation" in f ? f.operation ?? "new" : undefined;
    const makesSolid = f.kind === "extrude" || f.kind === "revolve" || f.kind === "primitive" || f.kind === "loft" || f.kind === "sweep"
      || (f.kind === "thread" && !f.spec.internal);
    if (makesSolid && (op === "new" || !last)) { out.set(f.id, f.id); last = f.id; continue; }
    out.set(f.id, "body" in f && f.body && f.body !== "last" ? f.body : last);
  }
  return out;
}

/** A connector's origin now: its expressions in the current parameters, else the stored point. */
function connectorOrigin(c: Connector, scope: Scope): Vec3 {
  if (!c.originExpr) return c.origin;
  const ev = (e: string, fallback: number) => { try { const v = compileExpr(e).eval(scope); return Number.isFinite(v) ? v : fallback; } catch { return fallback; } };
  return { x: ev(c.originExpr.x, c.origin.x), y: ev(c.originExpr.y, c.origin.y), z: ev(c.originExpr.z, c.origin.z) };
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
export function expandAssembly(doc: CadDocument, scope: Scope, opts: { framesOnly?: boolean } = {}): CadDocument {
  const patterns = Object.values(doc.componentPatterns ?? {});
  if (!patterns.length) return doc;

  // framesOnly: clone only components + joints (the kinematic frames), skipping
  // the sketch/feature geometry clone. Enough for FK; the fast render path builds
  // instance meshes by transforming the source mesh instead of rebuilding.
  const framesOnly = !!opts.framesOnly;
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
    // Template features: the profile features on its sketches, plus the
    // sketch-less modifiers (fillet, shell, hole…) aimed at a body one of them starts.
    const owner = featureBodies(doc);
    const onSketch = (f: FeatureDef) => "sketchId" in f && !!f.sketchId && subSketchSet.has(f.sketchId);
    const templateBodies = new Set(Object.values(doc.features).filter((f) => onSketch(f) && owner.get(f.id) === f.id).map((f) => f.id));
    const subFeatures = Object.values(doc.features).filter((f) => onSketch(f) || (!("sketchId" in f) && templateBodies.has(owner.get(f.id) ?? "")));
    const subFeatureSet = new Set(subFeatures.map((f) => f.id));

    // The template subtree is a stand-in; only its instances build.
    if (!framesOnly) for (const f of subFeatures) delete features[f.id];

    const iid = (i: number, localId: string) => `${p.id}#${i}__${localId}`;

    for (let i = 0; i < n; i++) {
      for (const cid of subComps) {
        const c = doc.components[cid];
        components[iid(i, cid)] = {
          ...c,
          id: iid(i, cid),
          parentId: c.parentId && subCompSet.has(c.parentId) ? iid(i, c.parentId) : doc.rootComponentId,
          children: c.children.filter((ch) => subCompSet.has(ch)).map((ch) => iid(i, ch)),
          sketches: framesOnly ? [] : c.sketches.filter((s) => subSketchSet.has(s)).map((s) => iid(i, s)),
          connectors: c.connectors ? { ...c.connectors } : undefined,
        };
      }
      if (!framesOnly) {
        for (const sk of subSketches) {
          sketches[iid(i, sk.id)] = cloneSketch(sk, iid(i, sk.id), sk.componentId ? iid(i, sk.componentId) : undefined);
        }
        for (const f of subFeatures) {
          const nf = { ...f, id: iid(i, f.id) } as typeof f & { sketchId?: string; body?: string };
          if ("sketchId" in nf && nf.sketchId) nf.sketchId = iid(i, nf.sketchId);
          else {
            // A sketch-less modifier: pin it to its instance body (never "the most
            // recent", which the interleaved instances would change) and evaluate
            // it in the template's frame, where its world-space selectors were authored.
            const body = owner.get(f.id)!;
            const comp = doc.sketches[(doc.features[body] as SketchFeature).sketchId].componentId!;
            nf.body = body;
            nf.instanceFrame = { component: iid(i, comp), template: comp };
          }
          if (nf.body && subFeatureSet.has(nf.body)) nf.body = iid(i, nf.body);
          features[iid(i, f.id)] = nf;
        }
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
      const origin = conn ? connectorOrigin(conn, scope) : (r.origin ?? { x: 0, y: 0, z: 0 });
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

// ---- fast render path: instance by transforming the source mesh -------------

function xformMesh(m: SolidMesh, T: Rigid): SolidMesh {
  const positions = new Float32Array(m.positions.length);
  const normals = new Float32Array(m.normals.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    const p = applyPoint(T, { x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
    positions[i] = p.x; positions[i + 1] = p.y; positions[i + 2] = p.z;
    const v = applyVec(T, { x: m.normals[i], y: m.normals[i + 1], z: m.normals[i + 2] });
    normals[i] = v.x; normals[i + 1] = v.y; normals[i + 2] = v.z;
  }
  const edges = new Float32Array(m.edges.length);
  for (let i = 0; i < m.edges.length; i += 3) {
    const p = applyPoint(T, { x: m.edges[i], y: m.edges[i + 1], z: m.edges[i + 2] });
    edges[i] = p.x; edges[i + 1] = p.y; edges[i + 2] = p.z;
  }
  // indices are copied, not shared: each instance mesh owns its buffers so the
  // worker can transfer them (a shared ArrayBuffer would be a duplicate transfer).
  return { positions, normals, indices: m.indices.slice(), edges, triangleCount: m.triangleCount };
}

function boundsOf(pos: Float32Array): Bounds3 {
  let nx = Infinity, ny = Infinity, nz = Infinity, xx = -Infinity, xy = -Infinity, xz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < nx) nx = x; if (y < ny) ny = y; if (z < nz) nz = z;
    if (x > xx) xx = x; if (y > xy) xy = y; if (z > xz) xz = z;
  }
  return { min: { x: nx, y: ny, z: nz }, max: { x: xx, y: xy, z: xz } };
}

/**
 * Turn the SOURCE bodies into the pattern's instance bodies by transforming the
 * baked mesh — no OCC rebuild. The source geometry is evaluated once (and stays
 * cacheable, since it doesn't depend on the joint-drive params); only these cheap
 * rigid transforms re-run as the mechanism articulates, so a slider drag or a
 * motion sweep is O(instances) vertex math instead of O(instances) OCC builds.
 *
 * Bodies outside every pattern subtree pass through unchanged. A body is assumed
 * to belong to one component (its sketch's) — the common case; a body fused
 * across several components of the subtree would be placed by that one frame.
 */
export function instanceSolids(doc: CadDocument, scope: Scope, sourceSolids: Record<string, SolidEval>): Record<string, SolidEval> {
  const patterns = Object.values(doc.componentPatterns ?? {});
  if (!patterns.length) return sourceSolids;

  const sourceWorlds = resolveComponentWorld(doc, scope);
  const instWorlds = resolveComponentWorld(expandAssembly(doc, scope, { framesOnly: true }), scope);

  const out: Record<string, SolidEval> = {};
  const templated = new Set<string>();
  for (const p of patterns) {
    const subComps = new Set(collectSubtree(doc, p.source));
    const n = evalCount(p.countExpr, scope, p.count);
    const iid = (i: number, localId: string) => `${p.id}#${i}__${localId}`;
    for (const [fid, sol] of Object.entries(sourceSolids)) {
      const comp = sol.sketchId ? doc.sketches[sol.sketchId]?.componentId : undefined;
      if (!comp || !subComps.has(comp)) continue;
      templated.add(fid); // a template body — replaced by its instances
      if (!sol.mesh) continue;
      const sInv = invert(sourceWorlds.get(comp) ?? IDENTITY);
      for (let i = 0; i < n; i++) {
        const iW = instWorlds.get(iid(i, comp));
        if (!iW) continue;
        const mesh = xformMesh(sol.mesh, compose(iW, sInv));
        out[iid(i, fid)] = { ...sol, featureId: iid(i, fid), name: `${sol.name} ${i + 1}`, mesh, bounds: boundsOf(mesh.positions), threadDecals: undefined };
      }
    }
  }
  for (const [fid, sol] of Object.entries(sourceSolids)) if (!templated.has(fid)) out[fid] = sol;
  return out;
}
