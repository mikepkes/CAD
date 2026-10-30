// Topological naming. Every face of every body carries a stable name of the
// form "<featureId>:<local>" — "extrude3:end", "extrude3:side:line7" (the
// sketch curve that swept it), "box1:+X", "hole9:bore" — assigned when the
// feature that creates it runs, then carried through every later operation by
// the kernel's own provenance (boolean history, shared surfaces, transform
// order; see occ/kernel.ts). Faces an operation creates are named by that
// operation and the faces around them: "fillet6:blend(box1:+X,box1:+Z)".
//
// A sketch on a face pins the face's name, so it follows that face when
// upstream edits move, resize or split it — instead of whatever planar face
// happens to sit nearest the original pick point. Edges are named by the faces
// they separate ("box1:+X|box1:+Z"), which fillet/chamfer selectors can use.
//
// Names are aligned with a shape's faces in OCC explorer order.

import { Vec3 } from "../math/vec";
import { WorkPlane, to2d } from "../geometry/plane";
import type { Sketch, SketchPoint } from "../sketch/types";
import { sampleSpline } from "./geometry/spline";
import { FaceGeom, EdgeGeom, edgeGeoms } from "./occ/kernel";
import type { Shape3D } from "replicad";

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1));

const SURFACE_LABEL: Record<string, string> = {
  PLANE: "plane", CYLINDRE: "cylinder", CYLINDER: "cylinder", CONE: "cone", SPHERE: "sphere", TORUS: "torus",
  BSPLINE_SURFACE: "bspline", BEZIER_SURFACE: "bezier", REVOLUTION_SURFACE: "revolved", EXTRUSION_SURFACE: "extruded", OFFSET_SURFACE: "offset",
};
const surfaceLabel = (t: string) => SURFACE_LABEL[t] ?? t.toLowerCase();

/** Give repeated names "#1", "#2", … in face order (unique names stay as they are). */
export function dedupe(names: string[]): string[] {
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((n) => {
    if ((count.get(n) ?? 0) < 2) return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return `${n}#${k}`;
  });
}

/** "+X" / "-Z" for a world-axis-aligned normal. */
function axisLabel(n: Vec3): string | undefined {
  const axes: [string, number][] = [["X", n.x], ["Y", n.y], ["Z", n.z]];
  for (const [a, c] of axes) if (Math.abs(c) > 0.9999) return `${c > 0 ? "+" : "-"}${a}`;
  return undefined;
}

/** Names from geometry alone — for a freshly built solid whose faces have no
 *  better provenance (primitives, lofts, sweeps, threads, imports): planar faces
 *  by axis ("+X") where aligned, curved faces by surface type ("cylinder"). */
export function genericNames(featureId: string, geoms: FaceGeom[]): string[] {
  return dedupe(geoms.map((g) => `${featureId}:${g.type === "PLANE" ? axisLabel(g.normal) ?? "plane" : surfaceLabel(g.type)}`));
}

// ---- sketch curves → the faces they sweep ----------------------------------

type P2 = { x: number; y: number };
const segDist = (p: P2, a: P2, b: P2) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
const polyDist = (p: P2, pts: P2[]) => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(p, pts[i], pts[i + 1])); return d; };

/** Distance from a sketch-plane point to every (non-construction) curve; the nearest curve's id. */
export function nearestCurve(sk: Sketch, p: P2): { id: string; distance: number } | undefined {
  const pt = (id: string) => sk.entities[id] as SketchPoint | undefined;
  let best: { id: string; distance: number } | undefined;
  for (const e of Object.values(sk.entities)) {
    if (e.kind === "point" || e.construction) continue;
    let d = Infinity;
    if (e.kind === "line") {
      const a = pt(e.p1), b = pt(e.p2);
      if (a && b) d = segDist(p, a, b);
    } else if (e.kind === "circle") {
      const c = pt(e.center);
      if (c) d = Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - e.r);
    } else if (e.kind === "arc") {
      const c = pt(e.center), a = pt(e.p1), b = pt(e.p2);
      if (c && a && b) {
        const ang = (q: P2) => Math.atan2(q.y - c.y, q.x - c.x);
        const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const [from, to] = e.ccw ? [ang(a), ang(b)] : [ang(b), ang(a)];
        const within = norm(ang(p) - from) <= norm(to - from) + 1e-9;
        d = within ? Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - e.r) : Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - b.x, p.y - b.y));
      }
    } else if (e.kind === "ellipse") {
      const c = pt(e.center);
      if (c) {
        const ring: P2[] = [];
        for (let i = 0; i <= 96; i++) {
          const t = (i / 96) * 2 * Math.PI, x = e.rx * Math.cos(t), y = e.ry * Math.sin(t);
          ring.push({ x: c.x + x * Math.cos(e.rotation) - y * Math.sin(e.rotation), y: c.y + x * Math.sin(e.rotation) + y * Math.cos(e.rotation) });
        }
        d = polyDist(p, ring);
      }
    } else if (e.kind === "spline") {
      const pts = e.points.map(pt).filter((q): q is SketchPoint => !!q);
      if (pts.length >= 2) d = polyDist(p, sampleSpline(pts, 16));
    }
    if (!best || d < best.distance) best = { id: e.id, distance: d };
  }
  return best;
}

/** Faces of an extrusion: the caps are "start" (on the sketch plane, or the
 *  near side of a symmetric extrude) and "end"; each side face is named by the
 *  sketch curve that swept it, "side:<curveId>". `dir` is the unit direction of
 *  travel (the sketch normal, flipped for a reverse extrude). */
export function extrudeNames(featureId: string, geoms: FaceGeom[], sk: Sketch, wp: WorkPlane, dir: Vec3): string[] {
  const caps = geoms.map((g, i) => ({ i, cap: g.type === "PLANE" && Math.abs(dot(g.normal, dir)) > 0.9999, along: dot(sub(g.center, wp.origin), dir) }));
  const capAlong = caps.filter((c) => c.cap).map((c) => c.along);
  const lo = Math.min(...capAlong), hi = Math.max(...capAlong);
  return dedupe(geoms.map((g, i) => {
    if (caps[i].cap) return `${featureId}:${Math.abs(caps[i].along - lo) <= Math.abs(caps[i].along - hi) ? "start" : "end"}`;
    const q = to2d(wp, g.point);
    const c = nearestCurve(sk, { x: q.u, y: q.v });
    return `${featureId}:side${c ? `:${c.id}` : ""}`;
  }));
}

/** Faces of a revolution: each swept face is named by its sketch curve,
 *  "rev:<curveId>"; a partial revolve's flat ends are "start" (in the sketch
 *  plane) and "end". `axisO`/`axisD` are the world axis. */
export function revolveNames(featureId: string, geoms: FaceGeom[], sk: Sketch, wp: WorkPlane, axisO: Vec3, axisD: Vec3): string[] {
  const d = unit(axisD);
  const e = unit(cross(wp.normal, d)); // in the sketch plane, perpendicular to the axis
  // which side of the axis the profile sits on, so faces rotate back onto it
  const sample = Object.values(sk.entities).find((x): x is SketchPoint => x.kind === "point" && !x.construction && x.id !== sk.originPointId);
  const sampleSide = sample ? Math.sign(dot(sub(add(wp.origin, add(mul(wp.u, sample.x), mul(wp.v, sample.y))), axisO), e)) || 1 : 1;
  const scale = Math.max(1, ...geoms.map((g) => Math.hypot(g.point.x - axisO.x, g.point.y - axisO.y, g.point.z - axisO.z)));
  return dedupe(geoms.map((g) => {
    const q = sub(g.point, axisO);
    const along = dot(q, d);
    const radial = sub(q, mul(d, along));
    const back = add(axisO, add(mul(d, along), mul(e, sampleSide * Math.hypot(radial.x, radial.y, radial.z))));
    const uv = to2d(wp, back);
    const c = nearestCurve(sk, { x: uv.u, y: uv.v });
    const onCurve = c && c.distance <= 1e-4 * scale;
    if (g.type === "PLANE" && !onCurve) return `${featureId}:${Math.abs(dot(sub(g.center, wp.origin), wp.normal)) <= 1e-6 * scale ? "start" : "end"}`;
    return `${featureId}:rev${c ? `:${c.id}` : ""}`;
  }));
}

/** Faces of a hole cutter in its local frame (mouth at the origin, drilling
 *  −Z): "bore", "floor", "cbore", "cbore-floor", "csink", "tip". */
export function holeCutterNames(featureId: string, geoms: FaceGeom[], spec: { radius: number; depth: number; counterbore?: { depth: number } }): string[] {
  return geoms.map((g) => {
    if (g.type === "PLANE") {
      if (g.center.z > 1e-9) return `${featureId}:mouth`;
      return `${featureId}:${spec.counterbore && Math.abs(g.center.z + spec.counterbore.depth) < 1e-6 ? "cbore-floor" : "floor"}`;
    }
    if (g.type === "CONE") return `${featureId}:${g.center.z < -spec.depth / 2 ? "tip" : "csink"}`;
    const r = Math.hypot(g.point.x, g.point.y);
    return `${featureId}:${Math.abs(r - spec.radius) < 1e-6 * Math.max(1, spec.radius) ? "bore" : "cbore"}`;
  });
}

// ---- carrying names through an operation -----------------------------------

/**
 * Names of an operation's output faces. A face with provenance takes its first
 * parent's name (booleans list the target body's faces first, so a face merged
 * from two bodies keeps the target's name). A face the operation created is
 * "<featureId>:<label>(<names of the faces around it>)"; with `offsetOf`, a
 * created planar face parallel to a named one is "<label>(<that name>)" (a
 * shell's inner walls).
 */
export function inheritNames(parentNames: string[], parents: number[][], out: Shape3D, featureId: string, label: string, opts: { geoms?: FaceGeom[]; offsetOf?: boolean } = {}): string[] {
  const names: (string | undefined)[] = parents.map((ps) => (ps.length ? parentNames[ps[0]] : undefined));
  const fresh = names.flatMap((n, j) => (n === undefined ? [j] : []));
  if (!fresh.length) return names as string[];
  const generated = new Map<number, string>();
  if (opts.offsetOf && opts.geoms) {
    const g = opts.geoms;
    for (const j of fresh) {
      if (g[j].type !== "PLANE") continue;
      let best: { name: string; gap: number } | undefined;
      names.forEach((n, i) => {
        // an offset wall faces the opposite way to the face it offsets (inward), so parallel either way
        if (n === undefined || g[i].type !== "PLANE" || Math.abs(dot(g[i].normal, g[j].normal)) < 0.9999) return;
        const gap = Math.abs(dot(sub(g[i].center, g[j].center), g[j].normal));
        if (!best || gap < best.gap) best = { name: n, gap };
      });
      if (best) generated.set(j, `${featureId}:${label}(${best.name})`);
    }
  }
  const rest = fresh.filter((j) => !generated.has(j));
  if (rest.length) {
    const edges = edgeGeoms(out);
    for (const j of rest) {
      const around = new Set<string>();
      for (const e of edges) if (e.faces.includes(j)) for (const i of e.faces) if (i !== j && names[i] !== undefined) around.add(names[i]!);
      generated.set(j, `${featureId}:${label}${around.size ? `(${[...around].sort().join(",")})` : ""}`);
    }
  }
  const unique = dedupe(fresh.map((j) => generated.get(j)!));
  fresh.forEach((j, k) => { names[j] = unique[k]; });
  return names as string[];
}

/** Names for a copy of a body (pattern instance, mirror image): its faces, in
 *  the same order, tagged with the copying feature. */
export const copyNames = (names: string[], tag: string): string[] => names.map((n) => `${n}@${tag}`);

/** Edge names: the (sorted) names of the faces each edge separates, "A|B";
 *  repeats get "#k" in edge order. A seam edge bounds one face: "A|A". */
export function edgeNamesOf(edges: EdgeGeom[], faceNames: string[]): string[] {
  return dedupe(edges.map((e) => {
    const fs = e.faces.map((i) => faceNames[i] ?? `f${i}`).sort();
    return (fs.length === 1 ? [fs[0], fs[0]] : fs).join("|");
  }));
}
