// OpenCASCADE kernel wrapper (via replicad). The ONLY module that imports
// replicad/OCCT, so the rest of the system stays kernel-agnostic. Turns a
// renderer-agnostic Profile on a WorkPlane into a solid: a tessellated mesh for
// display, and STL/STEP blobs for CNC / 3D-print output.

import opencascade from "replicad-opencascadejs";
import { setOC, draw, drawCircle, drawEllipse, makeBox, makeCylinder, makeSphere, makeHelix, genericSweep, Plane, measureVolume, type Drawing, type Shape3D, type Wire, type EdgeFinder, type FaceFinder } from "replicad";
import { ThreadForm, threadSection, threadLead, ThreadSection } from "../geometry/thread";
import { WorkPlane } from "../../geometry/plane";
import { Loop, LoopSegment, Profile, Pt } from "../geometry/profile";
import type { EdgeSelector, FaceSelector } from "../document";
import { splineTangents } from "../geometry/spline";
import { Vec3 } from "../../math/vec";

export interface SolidMesh {
  positions: Float32Array; // flat xyz
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array; // flat xyz, line segment pairs
  triangleCount: number;
}

/** A B-rep edge, classified and sampled in 3D world space (for projection). */
export interface Edge3D {
  type: "line" | "circle" | "arc" | "other";
  /** Sampled points along the edge (line = [start,end]; curves = many). */
  pts: { x: number; y: number; z: number }[];
  closed: boolean;
}

export interface KernelInitOptions {
  /** Browser: URL of replicad_single.wasm (Vite ?url import). */
  wasmUrl?: string;
  /** Node: the wasm bytes. */
  wasmBinary?: ArrayBuffer | Uint8Array;
}

let readyPromise: Promise<void> | null = null;
let ready = false;

export function initKernel(opts: KernelInitOptions): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const moduleOpts: Record<string, unknown> = { print: () => {}, printErr: () => {} };
      if (opts.wasmBinary) moduleOpts.wasmBinary = opts.wasmBinary;
      else if (opts.wasmUrl) moduleOpts.locateFile = () => opts.wasmUrl;
      const oc = await (opencascade as unknown as (o: unknown) => Promise<unknown>)(moduleOpts);
      setOC(oc as never);
      ready = true;
    })();
  }
  return readyPromise;
}

export const isKernelReady = (): boolean => ready;

function planeFor(wp: WorkPlane): Plane {
  return new Plane(
    [wp.origin.x, wp.origin.y, wp.origin.z],
    [wp.u.x, wp.u.y, wp.u.z],
    [wp.normal.x, wp.normal.y, wp.normal.z]
  );
}

function loopToDrawing(loop: Loop): Drawing {
  if (loop.circle) {
    return drawCircle(loop.circle.r).translate(loop.circle.center.x, loop.circle.center.y) as Drawing;
  }
  if (loop.ellipse) {
    const e = loop.ellipse;
    let d = drawEllipse(e.rx, e.ry) as Drawing;
    if (Math.abs(e.rotation) > 1e-9) d = d.rotate((e.rotation * 180) / Math.PI, [0, 0]) as Drawing;
    return d.translate(e.center.x, e.center.y) as Drawing;
  }
  let pen = draw([loop.start.x, loop.start.y]);
  const segs = loop.segments;
  // A spline segment becomes one cubic per span: control points a third of the
  // chord along the through-point tangents (replicad's default pole distance is
  // a quarter chord, hence the 4/3 factor) — the same cubic sampleSpline draws.
  const splineTo = (p: typeof pen, s: { through: { x: number; y: number }[] }) => {
    const t = splineTangents(s.through);
    let q = p;
    for (let i = 0; i < s.through.length - 1; i++) {
      q = (q as unknown as { smoothSplineTo: (e: [number, number], c: unknown) => typeof pen }).smoothSplineTo(
        [s.through[i + 1].x, s.through[i + 1].y],
        { startTangent: [t[i].x, t[i].y], endTangent: [t[i + 1].x, t[i + 1].y], startFactor: 4 / 3, endFactor: 4 / 3 }
      );
    }
    return q;
  };
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (s.kind === "line") pen = pen.lineTo([s.to.x, s.to.y]);
    else if (s.kind === "spline") pen = splineTo(pen, s);
    else pen = pen.threePointsArcTo([s.to.x, s.to.y], [s.via.x, s.via.y]);
  }
  // Final segment closes the loop (a straight close needs no explicit segment).
  const last = segs[segs.length - 1];
  if (last && last.kind === "arc") pen = pen.threePointsArcTo([last.to.x, last.to.y], [last.via.x, last.via.y]);
  else if (last && last.kind === "spline") pen = splineTo(pen, last);
  return pen.close();
}

function buildSolid(wp: WorkPlane, profile: Profile, distance: number): Shape3D {
  let drawing = loopToDrawing(profile.outer);
  for (const hole of profile.holes) {
    drawing = drawing.cut(loopToDrawing(hole));
  }
  const sketch = drawing.sketchOnPlane(planeFor(wp)) as { extrude: (d: number) => Shape3D };
  return sketch.extrude(distance);
}

/** Extrude one or more regions on a plane and fuse them into a single solid. */
export function buildRegionsSolid(wp: WorkPlane, regions: Profile[], distance: number): Shape3D {
  let result: Shape3D | null = null;
  for (const region of regions) {
    const s = buildSolid(wp, region, distance);
    if (!result) { result = s; continue; }
    const fused = (result as unknown as { fuse: (o: Shape3D) => Shape3D }).fuse(s);
    result.delete(); s.delete();
    result = fused;
  }
  if (!result) throw new Error("no regions to extrude");
  return result;
}

/** Build an OPEN drawing from a path (line/arc segments) — a sweep spine. */
function openPathToDrawing(path: { start: Pt; segments: LoopSegment[] }): Drawing {
  let pen = draw([path.start.x, path.start.y]);
  for (const s of path.segments) {
    if (s.kind === "line") pen = pen.lineTo([s.to.x, s.to.y]);
    else if (s.kind === "arc") pen = pen.threePointsArcTo([s.to.x, s.to.y], [s.via.x, s.via.y]);
    // (spline path segments are not produced by extractOpenPath yet)
  }
  // An open path is finalized with done() (not close(), which would seal it).
  return (pen as unknown as { done: () => Drawing }).done();
}

/** Sweep a profile region along an open path (its spine), both on their planes.
 *  Holes are swept separately and cut out — replicad can't sweep a profile that
 *  already has a hole, so a tube = (swept outer) − (swept inner). */
export function buildSweepSolid(profile: Profile, pathWp: WorkPlane, path: { start: Pt; segments: LoopSegment[] }): Shape3D {
  const sweepLoop = (loop: Loop): Shape3D => {
    // Rebuild the spine per loop so a consumed drawing never leaks between sweeps.
    const spine = openPathToDrawing(path).sketchOnPlane(planeFor(pathWp)) as unknown as {
      sweepSketch: (fn: (plane: unknown) => unknown, cfg: Record<string, unknown>) => Shape3D;
    };
    const prof = loopToDrawing(loop);
    return spine.sweepSketch((plane) => prof.sketchOnPlane(plane as never), {});
  };
  let solid = sweepLoop(profile.outer);
  for (const hole of profile.holes) {
    const inner = sweepLoop(hole);
    const next = (solid as unknown as { cut: (o: Shape3D) => Shape3D }).cut(inner);
    solid.delete();
    inner.delete();
    solid = next;
  }
  return solid;
}

/** Loft a solid through an ordered list of planar profiles (each on its own plane). */
export function buildLoftSolid(profiles: { wp: WorkPlane; region: Profile }[], ruled: boolean): Shape3D {
  if (profiles.length < 2) throw new Error("loft needs at least two profiles");
  const sketches = profiles.map((p) => {
    let d = loopToDrawing(p.region.outer);
    for (const hole of p.region.holes) d = d.cut(loopToDrawing(hole));
    return d.sketchOnPlane(planeFor(p.wp)) as unknown as { loftWith: (o: unknown, cfg: { ruled: boolean }) => Shape3D };
  });
  const [first, ...rest] = sketches;
  return first.loftWith(rest, { ruled });
}

/** Boolean-combine two solids. Consumes neither operand (caller frees them). */
export function fuseShapes(a: Shape3D, b: Shape3D): Shape3D {
  return (a as unknown as { fuse: (o: Shape3D, opts?: unknown) => Shape3D }).fuse(b);
}
export function cutShapes(base: Shape3D, tool: Shape3D): Shape3D {
  return (base as unknown as { cut: (o: Shape3D, opts?: unknown) => Shape3D }).cut(tool);
}
/** Intersection (common volume) of two solids. Consumes neither operand. */
export function intersectShapes(a: Shape3D, b: Shape3D): Shape3D {
  return (a as unknown as { intersect: (o: Shape3D) => Shape3D }).intersect(b);
}

/** Reflect a solid across a work plane, returning a NEW shape (operand untouched). */
export function mirrorShape(shape: Shape3D, wp: WorkPlane): Shape3D {
  // mirror() consumes the shape it is called on, so mirror a clone to keep `shape`.
  const clone = (shape as unknown as { clone: () => Shape3D }).clone();
  const plane = planeFor(wp);
  return (clone as unknown as { mirror: (p: Plane) => Shape3D }).mirror(plane);
}

/** Tessellate a solid into a display mesh. Does NOT free the shape. */
export function meshShape(solid: Shape3D): SolidMesh {
  const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.25 });
  const e = solid.meshEdges();
  return {
    positions: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    indices: Uint32Array.from(m.triangles),
    edges: Float32Array.from(e.lines),
    triangleCount: m.triangles.length / 3,
  };
}

/** Extrude a profile and return a display mesh. Frees the OCC shape. */
export function extrudeToMesh(wp: WorkPlane, profile: Profile, distance: number): SolidMesh {
  const solid = buildSolid(wp, profile, distance);
  try {
    const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.25 });
    const e = solid.meshEdges();
    return {
      positions: Float32Array.from(m.vertices),
      normals: Float32Array.from(m.normals),
      indices: Uint32Array.from(m.triangles),
      edges: Float32Array.from(e.lines),
      triangleCount: m.triangles.length / 3,
    };
  } finally {
    solid.delete();
  }
}

/** Classify + sample a solid's B-rep edges. Does NOT free the shape. */
export function edgesOfShape(solid: Shape3D): Edge3D[] {
  {
    const out: Edge3D[] = [];
    const edges = (solid as unknown as { edges: unknown[] }).edges;
    for (const e of edges as {
      geomType: string;
      startPoint: { x: number; y: number; z: number };
      endPoint: { x: number; y: number; z: number };
      pointAt: (t: number) => { x: number; y: number; z: number };
    }[]) {
      const type = String(e.geomType).toUpperCase();
      const sp = e.startPoint, ep = e.endPoint;
      const closed = Math.hypot(sp.x - ep.x, sp.y - ep.y, sp.z - ep.z) < 1e-6;
      if (type === "LINE") {
        out.push({ type: "line", pts: [{ x: sp.x, y: sp.y, z: sp.z }, { x: ep.x, y: ep.y, z: ep.z }], closed: false });
        continue;
      }
      const n = type === "CIRCLE" ? 24 : 40;
      const pts: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i <= n; i++) {
        const p = e.pointAt(i / n);
        pts.push({ x: p.x, y: p.y, z: p.z });
      }
      const kind: Edge3D["type"] = type === "CIRCLE" ? (closed ? "circle" : "arc") : "other";
      out.push({ type: kind, pts, closed });
    }
    return out;
  }
}

/** A planar B-rep face: its centroid and outward normal (for face references). */
export interface PlanarFace {
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/** The planar faces of a solid. Does NOT free the shape (frees the Face handles). */
export function planarFacesOfShape(solid: Shape3D): PlanarFace[] {
  const out: PlanarFace[] = [];
  const faces = (solid as unknown as { faces: unknown[] }).faces;
  for (const f of faces as {
    geomType: string;
    center: { x: number; y: number; z: number };
    normalAt: (p?: unknown) => { x: number; y: number; z: number };
    delete?: () => void;
  }[]) {
    try {
      if (String(f.geomType).toUpperCase() === "PLANE") {
        const c = f.center;
        const n = f.normalAt(c);
        out.push({ origin: { x: c.x, y: c.y, z: c.z }, normal: { x: n.x, y: n.y, z: n.z } });
      }
    } finally {
      f.delete?.();
    }
  }
  return out;
}

/** Extrude a profile and return its B-rep edges. Frees the shape. */
export function extrudeToEdges(wp: WorkPlane, profile: Profile, distance: number): Edge3D[] {
  const solid = buildSolid(wp, profile, distance);
  try { return edgesOfShape(solid); } finally { solid.delete(); }
}

/** STL/STEP blob for a solid. Does NOT free the shape. */
export function blobOfShape(solid: Shape3D, format: "stl" | "step"): Blob {
  return format === "stl" ? (solid as unknown as { blobSTL: (o: unknown) => Blob }).blobSTL({ binary: true }) : (solid as unknown as { blobSTEP: () => Blob }).blobSTEP();
}

/** Extrude a profile and return an STL or STEP blob. Frees the OCC shape. */
export function extrudeToBlob(wp: WorkPlane, profile: Profile, distance: number, format: "stl" | "step"): Blob {
  const solid = buildSolid(wp, profile, distance);
  try { return blobOfShape(solid, format); } finally { solid.delete(); }
}

// ---- solid modifiers (fillet / chamfer / shell / revolve / transforms) ------

type P3 = [number, number, number];
const p3 = (v: Vec3): P3 => [v.x, v.y, v.z];
const AXIS_DIR: Record<"X" | "Y" | "Z", P3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PLANE_NORMAL: Record<"XY" | "XZ" | "YZ", P3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

/** The origin-plane an EdgeSelector/FaceSelector names, as a replicad Plane at `offset`. */
function selectorPlane(name: "XY" | "XZ" | "YZ", offset = 0): Plane {
  // replicad's named planes use +Y as XZ's normal; our XZ normal is -Y, so build
  // the plane from the normal explicitly to keep "offset along the normal" exact.
  const n = PLANE_NORMAL[name];
  const xDir: P3 = name === "YZ" ? [0, 1, 0] : [1, 0, 0];
  return new Plane([n[0] * offset, n[1] * offset, n[2] * offset], xDir, n);
}

/** Apply an EdgeSelector to a finder (chained AND filters). */
function applyEdgeSelector(f: EdgeFinder, sel: EdgeSelector): EdgeFinder {
  if (sel.parallelTo) f = f.inDirection(AXIS_DIR[sel.parallelTo]);
  if (sel.inPlane) f = f.inPlane(selectorPlane(sel.inPlane.plane, sel.inPlane.offset ?? 0));
  if (sel.curveType === "line") f = f.ofCurveType("LINE");
  if (sel.curveType === "circle") f = f.ofCurveType("CIRCLE");
  if (sel.minLength !== undefined || sel.maxLength !== undefined) {
    const lo = sel.minLength ?? -Infinity, hi = sel.maxLength ?? Infinity;
    f = f.ofLength((l) => l >= lo && l <= hi);
  }
  if (sel.nearPoint) f = f.atDistance(0, p3(sel.nearPoint), 1e-3);
  if (sel.inBox) {
    const { min, max } = sel.inBox;
    const inside = (p: { x: number; y: number; z: number }) =>
      p.x >= min.x - 1e-6 && p.x <= max.x + 1e-6 && p.y >= min.y - 1e-6 && p.y <= max.y + 1e-6 && p.z >= min.z - 1e-6 && p.z <= max.z + 1e-6;
    f = f.when(({ element }) => {
      const e = element as unknown as { startPoint: Vec3; endPoint: Vec3; pointAt: (t: number) => Vec3 };
      return inside(e.startPoint) && inside(e.endPoint) && inside(e.pointAt(0.5));
    });
  }
  return f;
}

function applyFaceSelector(f: FaceFinder, sel: FaceSelector): FaceFinder {
  if (sel.parallelTo) f = f.parallelTo(selectorPlane(sel.parallelTo));
  if (sel.inPlane) f = f.inPlane(selectorPlane(sel.inPlane.plane, sel.inPlane.offset ?? 0));
  if (sel.nearPoint) f = f.atDistance(0, p3(sel.nearPoint), 1e-3);
  return f;
}

const isEmptySelector = (sel: object) => Object.values(sel).every((v) => v === undefined);

/** Fillet (round) or chamfer (bevel) the selected edges. Returns a NEW shape. */
export function blendEdges(shape: Shape3D, mode: "fillet" | "chamfer", size: number, sel: EdgeSelector): Shape3D {
  const s = shape as unknown as {
    fillet: (r: number, f?: (e: EdgeFinder) => EdgeFinder) => Shape3D;
    chamfer: (r: number, f?: (e: EdgeFinder) => EdgeFinder) => Shape3D;
    clone: () => Shape3D;
  };
  // fillet()/chamfer() consume the receiver: operate on a clone so `shape` survives.
  const clone = s.clone() as unknown as typeof s;
  const filter = isEmptySelector(sel) ? undefined : (e: EdgeFinder) => applyEdgeSelector(e, sel);
  return mode === "fillet" ? clone.fillet(size, filter) : clone.chamfer(size, filter);
}

/** Hollow a solid to `thickness`, removing the selected faces as openings. Returns a NEW shape. */
export function shellShape(shape: Shape3D, thickness: number, open: FaceSelector): Shape3D {
  if (isEmptySelector(open)) throw new Error("shell needs at least one face to open (openFaces)");
  const clone = (shape as unknown as { clone: () => Shape3D }).clone();
  return (clone as unknown as { shell: (t: number, f: (f: FaceFinder) => FaceFinder) => Shape3D })
    .shell(thickness, (f) => applyFaceSelector(f, open));
}

/** Revolve regions on a plane about a world axis (origin + direction) by `angle` degrees; fused. */
export function buildRegionsRevolved(wp: WorkPlane, regions: Profile[], axisOrigin: Vec3, axisDir: Vec3, angle: number): Shape3D {
  let result: Shape3D | null = null;
  for (const region of regions) {
    let drawing = loopToDrawing(region.outer);
    for (const hole of region.holes) drawing = drawing.cut(loopToDrawing(hole));
    const sk = drawing.sketchOnPlane(planeFor(wp)) as unknown as { revolve: (dir: P3, o: { origin: P3; angle: number }) => Shape3D };
    const s = sk.revolve(p3(axisDir), { origin: p3(axisOrigin), angle });
    if (!result) { result = s; continue; }
    const fused = fuseShapes(result, s);
    result.delete(); s.delete();
    result = fused;
  }
  if (!result) throw new Error("no regions to revolve");
  return result;
}

/** Translated copy of a shape (operand untouched). */
/** Revolve a closed (u=radius, v=height) profile a full turn about world Z. */
function revolveProfileZ(pts: [number, number][]): Shape3D {
  let pen = draw([pts[0][0], pts[0][1]]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo([pts[i][0], pts[i][1]]);
  const sk = pen.close().sketchOnPlane("XZ") as unknown as { revolve: (dir: P3, o: { origin: P3; angle: number }) => Shape3D };
  return sk.revolve([0, 0, 1], { origin: [0, 0, 0], angle: 360 });
}

/** A hole cutter, built along −Z with its mouth at the origin (going downward),
 *  ready to be oriented and placed at each hole centre and cut from a body. */
export interface HoleCutterSpec {
  radius: number;                               // bore radius
  depth: number;                                // cylindrical bore length (mouth → bottom)
  drillPoint?: boolean;                          // 118° conical tip at the bottom (blind drilled)
  counterbore?: { radius: number; depth: number };
  countersink?: { radius: number; angle: number }; // included angle, degrees
}

export function buildHoleCutter(s: HoleCutterSpec): Shape3D {
  const overshoot = Math.max(0.05, s.radius * 0.02); // break the mouth surface cleanly
  // Main bore: a cylinder from z=+overshoot down to z=−depth.
  const boreLen = s.depth + overshoot;
  let cutter = translateShape(makeCylinder(s.radius, boreLen) as Shape3D, { x: 0, y: 0, z: -s.depth });
  const fuseIn = (piece: Shape3D) => { const f = fuseShapes(cutter, piece); cutter.delete(); piece.delete(); cutter = f; };
  if (s.drillPoint) {
    const tip = s.radius / Math.tan((59 * Math.PI) / 180); // 118° included → 59° half-angle
    fuseIn(revolveProfileZ([[0, -s.depth], [s.radius, -s.depth], [0, -s.depth - tip]]));
  }
  if (s.counterbore) {
    fuseIn(translateShape(makeCylinder(s.counterbore.radius, s.counterbore.depth + overshoot) as Shape3D, { x: 0, y: 0, z: -s.counterbore.depth }));
  }
  if (s.countersink) {
    const half = (s.countersink.angle * Math.PI) / 360; // half the included angle
    const csDepth = (s.countersink.radius - s.radius) / Math.tan(half);
    // A frustum from the sink radius at the mouth down to the bore radius.
    fuseIn(revolveProfileZ([[0, overshoot], [s.countersink.radius + overshoot, overshoot], [s.countersink.radius, 0], [s.radius, -csDepth], [0, -csDepth]]));
  }
  return cutter;
}

/** A thread solid built along +Z with its base at the origin: a threaded rod
 *  (external form). An internal thread is this rod cut from a body (a tap). */
export interface ThreadBuildSpec {
  form: ThreadForm;
  pitch: number;
  majorDiameter: number;
  length: number;
  leftHand?: boolean;
  starts?: number;
  depth?: number;                              // radial thread height override
  representation?: "cosmetic" | "modeled";     // default cosmetic
  custom?: { x: number; y: number }[];
}

export function buildThread(s: ThreadBuildSpec): Shape3D {
  const rMaj = s.majorDiameter / 2;
  const starts = Math.max(1, Math.floor(s.starts ?? 1));
  const lead = threadLead(s.pitch, starts);
  const sec = threadSection(s.form, s.pitch, { depth: s.depth, custom: s.custom });
  const rMin = Math.max(0.1, rMaj - sec.depth);
  const len = s.length;
  if (!(len > 0)) throw new Error("thread length must be positive");

  if ((s.representation ?? "cosmetic") === "cosmetic") return buildThreadCosmetic(rMaj, sec.depth, s.pitch, len);

  const coreVol = Math.PI * rMin * rMin * len, majorVol = Math.PI * rMaj * rMaj * len;
  // OCC's helical sweep degenerates (silently drops the ribs) for some
  // profile/size combos, and which sweep config survives varies by form — so we
  // try a few and keep the first that validates, before the caller falls back to
  // cosmetic. Orthogonality-to-spine first (keeps the section radial).
  const configs: SweepConfig[] = [{ forceProfileSpineOthogonality: true }, { frenet: true }, {}];
  let lastErr: Error | null = null;
  for (const cfg of configs) {
    try {
      if (sec.mode === "groove") { // ballscrew: cut circular grooves from a major shaft
        let shaft = makeCylinder(rMaj, len) as Shape3D;
        for (let k = 0; k < starts; k++) {
          const g = sweepThreadSection(sec, rMaj, len, lead, !!s.leftHand, k, starts, cfg);
          const cut = cutShapes(shaft, g); shaft.delete(); g.delete(); shaft = cut;
        }
        return validateThread(trimRod(shaft, rMaj, len), (v) => v < majorVol * 0.995);
      }
      const embed = Math.min(0.03, sec.depth * 0.08);
      let rod = makeCylinder(rMin + embed, len) as Shape3D;
      for (let k = 0; k < starts; k++) {
        const rib = sweepThreadSection(sec, rMin, len, lead, !!s.leftHand, k, starts, cfg);
        const f = fuseShapes(rod, rib); rod.delete(); rib.delete(); rod = f;
      }
      return validateThread(trimRod(rod, rMaj, len), (v) => v > coreVol * 1.02 && v < majorVol * 1.02);
    } catch (e) { lastErr = e as Error; }
  }
  throw lastErr ?? new Error("modeled thread did not form");
}

type SweepConfig = { frenet?: boolean; forceProfileSpineOthogonality?: boolean };

/** Guard against OCC quietly dropping the thread ribs/grooves (some pitch/size
 *  combos degenerate to a bare cylinder): throw so the feature can fall back. */
function validateThread(rod: Shape3D, ok: (v: number) => boolean): Shape3D {
  const v = volumeOfShape(rod);
  if (!Number.isFinite(v) || !ok(v)) {
    rod.delete();
    throw new Error("modeled thread did not form cleanly (the kernel dropped the thread); try cosmetic, or a different pitch/diameter");
  }
  return rod;
}

/** Sweep one thread section along a helix (one start), returning the rib/groove
 *  solid. Multi-start copies are the same helix rotated (which, on a lead-pitch
 *  helix, is an exact axial interleave). */
function sweepThreadSection(sec: ThreadSection, rBase: number, len: number, lead: number, leftHand: boolean, startIndex: number, starts: number, cfg: SweepConfig): Shape3D {
  const xz = sec.poly.map((p) => [sec.mode === "rib" ? rBase + p.r : rBase - p.r, p.a] as [number, number]);
  let pen = draw([xz[0][0], xz[0][1]]);
  for (let i = 1; i < xz.length; i++) pen = pen.lineTo([xz[i][0], xz[i][1]]);
  const wire = (pen.close().sketchOnPlane("XZ") as unknown as { wire: Wire }).wire;
  // Run the helix from below z=0 to above len so the section is established at
  // both ends; the rod is trimmed flat afterwards.
  const helix = makeHelix(lead, len + 2 * lead, rBase, [0, 0, -lead], [0, 0, 1], leftHand);
  let swept = genericSweep(wire, helix, cfg) as Shape3D;
  if (startIndex > 0) {
    const rot = rotateShape(swept, (360 / starts) * startIndex, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    swept.delete(); swept = rot;
  }
  return swept;
}

/** Trim a thread solid to exactly z ∈ [0, len] with flat ends. */
function trimRod(shape: Shape3D, rMaj: number, len: number): Shape3D {
  const clip = makeCylinder(rMaj + 1, len) as Shape3D;
  const out = intersectShapes(shape, clip);
  shape.delete(); clip.delete();
  return out;
}

/** A cheap cosmetic thread: a plain major cylinder with shallow revolved V-ring
 *  hints at the pitch spacing (robust and low-poly; a visual cue, not a mating
 *  thread — a true shaded/bump-mapped thread needs the material system). */
function buildThreadCosmetic(rMaj: number, depth: number, pitch: number, len: number): Shape3D {
  let rod = makeCylinder(rMaj, len) as Shape3D;
  const rings = Math.min(60, Math.max(1, Math.floor(len / pitch)));
  const spacing = len / rings;
  const ringDepth = Math.min(depth * 0.55, rMaj * 0.6);
  const ah = pitch * 0.28;
  for (let i = 0; i < rings; i++) {
    const z = (i + 0.5) * spacing;
    const groove = revolveProfileZ([[rMaj + 0.01, z - ah], [rMaj - ringDepth, z], [rMaj + 0.01, z + ah]]);
    const cut = cutShapes(rod, groove); rod.delete(); groove.delete(); rod = cut;
  }
  return rod;
}

/** A parametric primitive solid (no sketch): built centred on `at`. */
export interface PrimitiveSpec {
  shape: "box" | "cylinder" | "cone" | "sphere" | "torus";
  at: Vec3;
  x?: number; y?: number; z?: number; // box
  radius?: number;                    // cylinder/cone/sphere/torus (ring radius)
  radius2?: number;                   // cone far-end radius (default 0 → point)
  height?: number;                    // cylinder/cone
  tube?: number;                      // torus tube radius
}

/** Build a primitive solid directly (box/cylinder/cone/sphere/torus), centred on
 *  `at` — so a box/sphere is centred, and a cylinder/cone is centred on its axis
 *  mid-height. One kernel call instead of sketch→extrude/revolve. */
export function buildPrimitive(s: PrimitiveSpec): Shape3D {
  const req = (v: number | undefined, name: string): number => {
    if (v == null || !Number.isFinite(v)) throw new Error(`primitive ${s.shape} needs "${name}"`);
    return v;
  };
  const moveTo = (shape: Shape3D, p: Vec3): Shape3D => {
    if (p.x === 0 && p.y === 0 && p.z === 0) return shape;
    const t = translateShape(shape, p);
    shape.delete();
    return t;
  };
  switch (s.shape) {
    case "box": {
      const x = req(s.x, "x") / 2, y = req(s.y, "y") / 2, z = req(s.z, "z") / 2;
      return makeBox([s.at.x - x, s.at.y - y, s.at.z - z], [s.at.x + x, s.at.y + y, s.at.z + z]) as Shape3D;
    }
    case "sphere":
      return moveTo(makeSphere(req(s.radius, "radius")) as Shape3D, s.at);
    case "cylinder": {
      const h = req(s.height, "height");
      return moveTo(makeCylinder(req(s.radius, "radius"), h) as Shape3D, { x: s.at.x, y: s.at.y, z: s.at.z - h / 2 });
    }
    case "cone": {
      const h = req(s.height, "height"), r1 = req(s.radius, "radius"), r2 = s.radius2 ?? 0;
      const pts: [number, number][] = r2 > 1e-9 ? [[0, 0], [r1, 0], [r2, h], [0, h]] : [[0, 0], [r1, 0], [0, h]];
      return moveTo(revolveProfileZ(pts), { x: s.at.x, y: s.at.y, z: s.at.z - h / 2 });
    }
    case "torus": {
      const R = req(s.radius, "radius"), t = req(s.tube, "tube");
      const sk = (drawCircle(t).translate(R, 0) as Drawing).sketchOnPlane("XZ") as unknown as { revolve: (dir: P3, o: { origin: P3; angle: number }) => Shape3D };
      return moveTo(sk.revolve([0, 0, 1], { origin: [0, 0, 0], angle: 360 }), s.at);
    }
  }
  throw new Error(`unknown primitive "${s.shape}"`);
}

export function translateShape(shape: Shape3D, v: Vec3): Shape3D {
  const clone = (shape as unknown as { clone: () => Shape3D }).clone();
  return (clone as unknown as { translate: (x: number, y: number, z: number) => Shape3D }).translate(v.x, v.y, v.z);
}

/** Rotated copy of a shape about an axis (degrees; operand untouched). */
export function rotateShape(shape: Shape3D, angleDeg: number, origin: Vec3, dir: Vec3): Shape3D {
  const clone = (shape as unknown as { clone: () => Shape3D }).clone();
  return (clone as unknown as { rotate: (a: number, o: P3, d: P3) => Shape3D }).rotate(angleDeg, p3(origin), p3(dir));
}

export interface Bounds3 { min: Vec3; max: Vec3 }

/** Axis-aligned bounds of a shape (world). */
export function boundsOfShape(shape: Shape3D): Bounds3 {
  const bb = (shape as unknown as { boundingBox: { bounds: [P3, P3]; delete?: () => void } }).boundingBox;
  const [lo, hi] = bb.bounds;
  bb.delete?.();
  return { min: { x: lo[0], y: lo[1], z: lo[2] }, max: { x: hi[0], y: hi[1], z: hi[2] } };
}

/** Enclosed volume of a solid (mm³). */
export function volumeOfShape(shape: Shape3D): number {
  try { return measureVolume(shape); } catch { return NaN; }
}
