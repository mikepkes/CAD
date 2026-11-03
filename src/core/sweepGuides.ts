// A 3D sweep's construction, drawn: the spine it runs along and its sections where they sit on it. A 3D path's
// sketch holds no curves (only the plane that frames the path's points), so showing that sketch would draw nothing;
// instead, a shown path sketch draws the path it frames and the sections placed square to it: each section at its
// station, or, for one profile with a scale law, the profile at even steps along the spine, scaled as the law says
// (the taper reads at a glance). Plain math from the same spec the kernel sweeps (spineSweepSpec), no kernel.

import type { CadDocument, SweepFeature } from "./document";
import type { Scope } from "../math/expr";
import type { Vec3 } from "../math/vec";
import type { WorkPlane } from "../geometry/plane";
import { spineSweepSpec } from "./features";
import { curveDerivs, paramAtLength, sectionPlane, spineTable } from "./geometry/spine";
import { loopPolygon, type Profile } from "./geometry/profile";

export interface SweepGuide {
  /** The sweep feature. */
  featureId: string;
  /** Its path sketch (the one whose plane frames the 3D points): the guide is drawn, hidden and faded with it. */
  sketchId: string;
  /** The path sketch's component (the guide moves with it when parts are posed). */
  componentId?: string;
  /** The spine, as a polyline. */
  spine: Vec3[];
  /** Each section's loops (outer, then holes) as closed polylines (last point = first), in order along the spine. */
  sections: Vec3[][][];
}

const place = (wp: WorkPlane, k: number, p: { x: number; y: number }): Vec3 => ({
  x: wp.origin.x + k * (wp.u.x * p.x + wp.v.x * p.y),
  y: wp.origin.y + k * (wp.u.y * p.x + wp.v.y * p.y),
  z: wp.origin.z + k * (wp.u.z * p.x + wp.v.z * p.y),
});
const loops = (region: Profile, wp: WorkPlane, k = 1): Vec3[][] =>
  [region.outer, ...region.holes].map((l) => { const pts = loopPolygon(l).map((p) => place(wp, k, p)); return pts.length ? [...pts, pts[0]] : pts; });

/** The law's value at spine parameter `t` (its samples interpolated). */
function lawAt(law: { t: number[]; value: number[] }, t: number): number {
  const { t: ts, value } = law;
  if (t <= ts[0]) return value[0];
  for (let i = 1; i < ts.length; i++) if (t <= ts[i]) { const f = (t - ts[i - 1]) / (ts[i] - ts[i - 1] || 1); return value[i - 1] + f * (value[i] - value[i - 1]); }
  return value[value.length - 1];
}

/** A 3D sweep's guide, or null for a sweep along a sketched (2D) path or one whose path doesn't resolve.
 *  `step`: the spacing (mm) of the scaled profiles along a scale law's spine (at least 5 of them, ends included). */
export function sweepGuide(doc: CadDocument, scope: Scope, f: SweepFeature, step = 60): SweepGuide | null {
  if (!f.path3d) return null;
  let spec: ReturnType<typeof spineSweepSpec>;
  try { spec = spineSweepSpec(doc, scope, f); } catch { return null; }
  const tab = spineTable(spec.spine);
  const n = 240, spine: Vec3[] = [];
  for (let i = 0; i <= n; i++) spine.push(curveDerivs(spec.spine, paramAtLength(tab, (tab.length * i) / n)).p);
  let sections: Vec3[][][];
  if (spec.law) {
    const law = spec.law, region = spec.sections[0].region;
    const count = Math.max(5, Math.round(tab.length / step) + 1);
    let prev: WorkPlane | undefined;
    sections = Array.from({ length: count }, (_, i) => {
      const t = paramAtLength(tab, (tab.length * i) / (count - 1));
      prev = sectionPlane(spec.spine, t, spec.up, prev);
      return loops(region, prev, lawAt(law, t));
    });
  } else {
    sections = spec.sections.map((s) => loops(s.region, s.wp));
    // one profile and no law: it rides the whole way, so show it at the far end too
    if (spec.sections.length === 1) sections.push(loops(spec.sections[0].region, sectionPlane(spec.spine, 1, spec.up, spec.sections[0].wp)));
  }
  return { featureId: f.id, sketchId: f.pathSketch, componentId: doc.sketches[f.pathSketch]?.componentId, spine, sections };
}

/** The guides of the 3D sweeps whose path sketch is in `shown` (the sketches the view draws) and that `isOn`. */
export function sweepGuides(doc: CadDocument, scope: Scope, shown: Set<string>, isOn: (f: SweepFeature) => boolean = () => true): SweepGuide[] {
  const out: SweepGuide[] = [];
  for (const f of Object.values(doc.features)) {
    if (f.kind !== "sweep" || !f.path3d || !shown.has(f.pathSketch) || !isOn(f)) continue;
    const g = cached(doc, scope, f);
    if (g) out.push(g);
  }
  return out;
}

// the view is rebuilt on every store change: a guide is worked out again only when its feature, its sketches or the
// parameters change
const memo = new WeakMap<SweepFeature, { params: unknown; sketches: unknown[]; scope: string; guide: SweepGuide | null }>();
function cached(doc: CadDocument, scope: Scope, f: SweepFeature): SweepGuide | null {
  const sketches = [f.pathSketch, f.profileSketch, ...(f.sections ?? []).map((s) => s.sketch)].map((id) => doc.sketches[id]);
  const key = JSON.stringify(scope);
  const m = memo.get(f);
  if (m && m.params === doc.parameters && m.scope === key && m.sketches.every((s, i) => s === sketches[i])) return m.guide;
  const guide = sweepGuide(doc, scope, f);
  memo.set(f, { params: doc.parameters, sketches, scope: key, guide });
  return guide;
}
