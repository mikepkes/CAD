// OpenCASCADE kernel wrapper (via replicad). The ONLY module that imports
// replicad/OCCT, so the rest of the system stays kernel-agnostic. Turns a
// renderer-agnostic Profile on a WorkPlane into a solid: a tessellated mesh for
// display, and STL/STEP blobs for CNC / 3D-print output.

import opencascade from "replicad-opencascadejs";
import { setOC, getOC, cast, isShape3D, measureArea, measureDistanceBetween, makeAx1, makeCompound, draw, drawCircle, drawEllipse, makeBox, makeCylinder, makeSphere, makeHelix, genericSweep, Plane, measureVolume, type Drawing, type Shape3D, type Wire, type EdgeFinder, type FaceFinder } from "replicad";
import { ThreadForm, threadSection, threadLead, ThreadSection } from "../geometry/thread";
import { WorkPlane } from "../../geometry/plane";
import { Loop, LoopSegment, Profile, Pt } from "../geometry/profile";
import type { EdgeSelector, FaceSelector } from "../document";
import { splineTangents } from "../geometry/spline";
import { NurbsBrepData, NurbsCurveData, NurbsFaceData, NurbsSurfaceData, knotMults } from "../nurbs";
import { Vec3 } from "../../math/vec";

export interface SolidMesh {
  positions: Float32Array; // flat xyz
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array; // flat xyz, line segment pairs
  triangleCount: number;
  /** Per B-rep face, in face order: [start, count] into `indices` (flat pairs). */
  faceRanges?: number[];
  /** Topological name of each face (aligned with faceRanges), when known. */
  faceNames?: string[];
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

/** Text for anything a kernel call threw. OCC failures surface as a bare
 *  WebAssembly.Exception with no message, which would otherwise read as
 *  `undefined` and hide the failure entirely. */
export function kernelErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof WebAssembly !== "undefined" && "Exception" in WebAssembly && e instanceof (WebAssembly as unknown as { Exception: new (...a: never[]) => object }).Exception) {
    return "the geometry kernel could not build this (OpenCASCADE raised an exception) — the size or selection probably doesn't fit the shape";
  }
  return typeof e === "string" && e ? e : "the geometry kernel failed";
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

/** Regions on a plane as flat faces (one face, or a compound when there are several). */
export function regionsFace(wp: WorkPlane, regions: Profile[]): Shape3D {
  const faces = regions.map((r) => {
    let drawing = loopToDrawing(r.outer);
    for (const hole of r.holes) drawing = drawing.cut(loopToDrawing(hole));
    const sk = drawing.sketchOnPlane(planeFor(wp)) as unknown as { face?: () => Shape3D; faces?: () => Shape3D };
    return sk.face ? sk.face() : sk.faces!();
  });
  if (!faces.length) throw new Error("no regions");
  return asOne(faces);
}

/** Build an OPEN drawing from a path (line/arc segments) — a sweep spine. */
/** Continue a pen through a spline's points as cubic pieces (the same cubics sampleSpline draws). */
function splineThrough<T>(pen: T, through: { x: number; y: number }[]): T {
  const t = splineTangents(through);
  let q = pen;
  for (let i = 0; i < through.length - 1; i++) {
    q = (q as unknown as { smoothSplineTo: (e: [number, number], c: unknown) => T }).smoothSplineTo(
      [through[i + 1].x, through[i + 1].y],
      { startTangent: [t[i].x, t[i].y], endTangent: [t[i + 1].x, t[i + 1].y], startFactor: 4 / 3, endFactor: 4 / 3 }
    );
  }
  return q;
}

function openPathToDrawing(path: { start: Pt; segments: LoopSegment[] }): Drawing {
  let pen = draw([path.start.x, path.start.y]);
  for (const s of path.segments) {
    if (s.kind === "line") pen = pen.lineTo([s.to.x, s.to.y]);
    else if (s.kind === "arc") pen = pen.threePointsArcTo([s.to.x, s.to.y], [s.via.x, s.via.y]);
    else pen = splineThrough(pen, s.through);
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

/** Edge polylines at the faces' own tolerance: replicad's default (0.001 mm)
 *  is far finer than the shading mesh and took seconds on a spline-revolved
 *  surface. */
const EDGE_MESH = { tolerance: 0.05, angularTolerance: 0.25 };

/** Tessellate a solid into a display mesh. Does NOT free the shape. */
export function meshShape(solid: Shape3D): SolidMesh {
  const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.25 }) as ReturnType<Shape3D["mesh"]> & { faceGroups?: { start: number; count: number }[] };
  const e = solid.meshEdges(EDGE_MESH);
  return {
    positions: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    indices: Uint32Array.from(m.triangles),
    edges: Float32Array.from(e.lines),
    triangleCount: m.triangles.length / 3,
    faceRanges: (m.faceGroups ?? []).flatMap((g) => [g.start, g.count]),
  };
}

/** Extrude a profile and return a display mesh. Frees the OCC shape. */
export function extrudeToMesh(wp: WorkPlane, profile: Profile, distance: number): SolidMesh {
  const solid = buildSolid(wp, profile, distance);
  try {
    const m = solid.mesh({ tolerance: 0.05, angularTolerance: 0.25 });
    const e = solid.meshEdges(EDGE_MESH);
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

/** Whether an edge's topological name matches a requested one: face pairs
 *  compare order-free, and a request without "#k" matches every copy. */
export function edgeNameMatches(name: string | undefined, want: string): boolean {
  if (!name) return false;
  const norm = (n: string) => { const [base, k] = n.split("#"); return base.split("|").sort().join("|") + (k ? `#${k}` : ""); };
  const n = norm(name), w = norm(want);
  return n === w || (!want.includes("#") && n.split("#")[0] === w);
}

/** Fillet (round) or chamfer (bevel) the selected edges. Returns a NEW shape.
 *  `edgeNames` (aligned with the shape's edges) resolves a `names` selector. */
export function blendEdges(shape: Shape3D, mode: "fillet" | "chamfer", size: number, sel: EdgeSelector, edgeNames?: string[]): Shape3D {
  const s = shape as unknown as {
    fillet: (r: number, f?: (e: EdgeFinder) => EdgeFinder) => Shape3D;
    chamfer: (r: number, f?: (e: EdgeFinder) => EdgeFinder) => Shape3D;
    clone: () => Shape3D;
  };
  // fillet()/chamfer() consume the receiver: operate on a clone so `shape` survives.
  const clone = s.clone() as unknown as typeof s;
  const named = sel.names?.length ? edgesOf(shape) : [];
  try {
    let byName: ((e: OcEdge) => boolean) | undefined;
    if (sel.names?.length) {
      const find = indexer(named);
      byName = (e) => { const i = find(e.wrapped, e.hashCode); return i >= 0 && sel.names!.some((w) => edgeNameMatches(edgeNames?.[i], w)); };
    }
    const filter = isEmptySelector(sel) ? undefined : (e: EdgeFinder) => {
      const f = applyEdgeSelector(e, sel);
      return byName ? f.when(({ element }) => byName!(element as unknown as OcEdge)) : f;
    };
    return mode === "fillet" ? clone.fillet(size, filter) : clone.chamfer(size, filter);
  } finally { freeAll(named); }
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

// ---- topology + provenance (for topological naming) -------------------------
//
// Faces are addressed by their index in OCC explorer order — the order
// `shape.faces` and the mesh's face groups use, and which a transform copy
// preserves. Provenance between an operation's input and output faces comes
// from the kernel itself: boolean history (Modified / IsDeleted, including
// SimplifyResult's merges) or, for fillet/chamfer/shell, the Geom_Surface an
// output face still shares with the input face it was trimmed from.

type OcFace = { wrapped: { IsSame(o: unknown): boolean }; hashCode: number; geomType: string; center: Vec3; normalAt(p?: unknown): Vec3; pointOnSurface(u: number, v: number): Vec3; edges: OcEdge[]; delete(): void };
type OcEdge = { wrapped: { IsSame(o: unknown): boolean }; hashCode: number; geomType: string; length: number; startPoint: Vec3; endPoint: Vec3; pointAt(t: number): Vec3; delete(): void };
const facesOf = (s: Shape3D): OcFace[] => (s as unknown as { faces: OcFace[] }).faces;
const edgesOf = (s: Shape3D): OcEdge[] => (s as unknown as { edges: OcEdge[] }).edges;
const freeAll = (xs: { delete(): void }[]) => { for (const x of xs) { try { x.delete(); } catch { /* already freed */ } } };

/** Index of `shape` in `list` (by OCC IsSame), bucketed by hash code. */
function indexer<T extends { wrapped: { IsSame(o: unknown): boolean }; hashCode: number }>(list: T[]): (s: { IsSame(o: unknown): boolean }, hash: number) => number {
  const buckets = new Map<number, number[]>();
  list.forEach((x, i) => { const b = buckets.get(x.hashCode); if (b) b.push(i); else buckets.set(x.hashCode, [i]); });
  return (s, hash) => {
    for (const i of buckets.get(hash) ?? []) if (list[i].wrapped.IsSame(s)) return i;
    return -1;
  };
}

/** One face's geometry, for naming and topology reports. */
export interface FaceGeom {
  /** OCC surface type: PLANE, CYLINDRE, CONE, SPHERE, TORUS, BSPLINE_SURFACE, … */
  type: string;
  center: Vec3;
  /** Normal at the centre (outward for a solid's face). */
  normal: Vec3;
  /** A point ON the face (its UV mid-point; `center` is the area centroid,
   *  which for a curved face lies off the surface). */
  point: Vec3;
  area: number;
}

export function faceGeoms(shape: Shape3D): FaceGeom[] {
  const faces = facesOf(shape);
  try {
    return faces.map((f) => {
      const v = (q: Vec3): Vec3 => ({ x: q.x, y: q.y, z: q.z });
      const type = String(f.geomType).toUpperCase();
      const c = v(f.center);
      // A point ON the face: a curved face's centroid can sit on its axis.
      let p = c;
      try { p = v(f.pointOnSurface(0.5, 0.5)); } catch { /* keep the centroid */ }
      // (at the UV mid-point, same as `p`; OCC's face normal is unnormalised —
      // its length is the surface's area element there)
      let n: Vec3 = { x: 0, y: 0, z: 0 };
      try { const raw = v(f.normalAt()); const m = Math.hypot(raw.x, raw.y, raw.z); if (m > 0) n = { x: raw.x / m, y: raw.y / m, z: raw.z / m }; } catch { /* leave zero */ }
      let area = NaN;
      try { area = measureArea(f as never); } catch { /* leave NaN */ }
      return { type, center: c, normal: n, point: p, area };
    });
  } finally { freeAll(faces); }
}

/** One edge: its geometry and the indices of the faces it bounds. */
export interface EdgeGeom {
  type: string;
  length: number;
  mid: Vec3;
  faces: number[];
}

export function edgeGeoms(shape: Shape3D): EdgeGeom[] {
  const faces = facesOf(shape), edges = edgesOf(shape);
  const faceEdges: OcEdge[] = [];
  try {
    const owners = new Map<number, number[]>(); // edge hash → face indices
    const faceEdgeLists = faces.map((f, i) => {
      const es = f.edges;
      faceEdges.push(...es);
      for (const e of es) { const b = owners.get(e.hashCode); if (b) b.push(i); else owners.set(e.hashCode, [i]); }
      return es;
    });
    return edges.map((e) => {
      const adj = new Set<number>();
      for (const i of owners.get(e.hashCode) ?? []) if (faceEdgeLists[i].some((fe) => fe.wrapped.IsSame(e.wrapped))) adj.add(i);
      const m = e.pointAt(0.5);
      let length = NaN;
      try { length = e.length; } catch { /* leave NaN */ }
      return { type: String(e.geomType).toUpperCase(), length, mid: { x: m.x, y: m.y, z: m.z }, faces: [...adj].sort((a, b) => a - b) };
    });
  } finally { freeAll(faceEdges); freeAll(edges); freeAll(faces); }
}

export type BooleanKind = "fuse" | "cut" | "intersect";

/** A boolean plus its face provenance: `parents[j]` lists the input faces that
 *  became result face j, as indices into [...faces(a), ...faces(b)] (so b's
 *  faces start at faces(a).length). Consumes neither operand. */
export function booleanWithHistory(kind: BooleanKind, a: Shape3D, b: Shape3D): { shape: Shape3D; parents: number[][] } {
  type Builder = { Build(): void; IsDone(): boolean; SimplifyResult(u: boolean, v: boolean, tol: number): void; Shape(): unknown; Modified(s: unknown): OcList; IsDeleted(s: unknown): boolean; delete(): void };
  type OcList = { Size(): number; First(): { IsSame(o: unknown): boolean; HashCode?(n: number): number }; RemoveFirst(): void; delete(): void };
  const oc = getOC() as unknown as Record<string, new (a: unknown, b: unknown) => Builder>;
  const ctor = kind === "fuse" ? oc.BRepAlgoAPI_Fuse : kind === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const aw = (a as unknown as { wrapped: unknown }).wrapped, bw = (b as unknown as { wrapped: unknown }).wrapped;
  const builder = new ctor(aw, bw);
  const inputs = [...facesOf(a), ...facesOf(b)];
  let outFaces: OcFace[] = [];
  try {
    builder.Build();
    if (!builder.IsDone()) throw new Error(`${kind} failed in the kernel`);
    builder.SimplifyResult(true, true, 1e-3);
    const shape = cast(builder.Shape() as never) as unknown as Shape3D;
    if (!isShape3D(shape as never)) throw new Error(`${kind} did not produce a solid`);
    outFaces = facesOf(shape);
    const find = indexer(outFaces);
    const hashOf = (s: unknown) => (cast(s as never) as unknown as { hashCode: number; delete(): void });
    const parents: number[][] = outFaces.map(() => []);
    inputs.forEach((f, i) => {
      if (builder.IsDeleted(f.wrapped)) return;
      const mods = builder.Modified(f.wrapped);
      try {
        if (mods.Size() === 0) { const j = find(f.wrapped, f.hashCode); if (j >= 0) parents[j].push(i); return; }
        while (mods.Size() > 0) {
          const m = mods.First();
          const h = hashOf(m);
          const j = find(m, h.hashCode);
          h.delete();
          if (j >= 0 && !parents[j].includes(i)) parents[j].push(i);
          mods.RemoveFirst();
        }
      } finally { mods.delete(); }
    });
    return { shape, parents };
  } finally {
    freeAll(outFaces); freeAll(inputs); builder.delete();
  }
}

/** Provenance by shared surface: output face j's parents are the input faces
 *  whose Geom_Surface it still carries (a face trimmed by a fillet, chamfer or
 *  shell keeps its surface; faces the operation created have none). */
export function surfaceParents(input: Shape3D, output: Shape3D): number[][] {
  type Surf = { isAliasOf(o: unknown): boolean; delete?(): void };
  const oc = getOC() as unknown as { TopLoc_Location: new () => { delete(): void }; BRep_Tool: { Surface(f: unknown, l: unknown): Surf } };
  const ins = facesOf(input), outs = facesOf(output);
  const loc = new oc.TopLoc_Location();
  try {
    const surf = (f: OcFace) => oc.BRep_Tool.Surface(f.wrapped, loc);
    const inSurfs = ins.map(surf);
    return outs.map((f) => {
      const s = surf(f);
      const out: number[] = [];
      inSurfs.forEach((t, i) => { if (t.isAliasOf(s)) out.push(i); });
      return out;
    });
  } finally { loc.delete(); freeAll(ins); freeAll(outs); }
}

let importSeq = 0;

/** Read a STEP file (its text) into one shape — a solid, or a compound when the
 *  file holds several. Synchronous (through OCC's in-memory file system), so it
 *  can run inside feature evaluation. */
export function readStep(text: string): Shape3D {
  type Status = { value?: number };
  const oc = getOC() as unknown as {
    FS: { writeFile(p: string, d: string): void; unlink(p: string): void };
    STEPControl_Reader: new () => { ReadFile(p: string): Status; TransferRoots(): number; NbShapes(): number; OneShape(): unknown; delete(): void };
    IFSelect_ReturnStatus: { IFSelect_RetDone: Status };
  };
  const file = `/chisel-import-${++importSeq}.step`;
  oc.FS.writeFile(file, text);
  const reader = new oc.STEPControl_Reader();
  try {
    if (reader.ReadFile(file) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("not a readable STEP file");
    reader.TransferRoots();
    if (reader.NbShapes() < 1) throw new Error("the STEP file has no shapes");
    const shape = cast(reader.OneShape() as never) as unknown as Shape3D;
    if (!isShape3D(shape as never)) throw new Error("the STEP file has no solid geometry");
    return shape;
  } finally {
    reader.delete();
    try { oc.FS.unlink(file); } catch { /* already gone */ }
  }
}

/** Keep a shape's solids (a compound of them when several); throw when it has none. */
function solidsOnly(shape: Shape3D, what: string): Shape3D {
  const solids = (shape as unknown as { solids?: Shape3D[] }).solids ?? [];
  if (!solids.length) { shape.delete(); throw new Error(`the ${what} has no solid geometry`); }
  if (solids.length === 1) { shape.delete(); return solids[0]; }
  for (const x of solids) x.delete();
  return shape;
}

/** A shape as OpenCASCADE's native BREP text. */
export function brepOfShape(shape: Shape3D | { wrapped: unknown }): string {
  const oc = getOC() as unknown as { BRepToolsWrapper: { Write(s: unknown): string } };
  return oc.BRepToolsWrapper.Write((shape as unknown as { wrapped: unknown }).wrapped);
}

/** Read OpenCASCADE's native BREP text (FreeCAD stores shapes this way). */
export function readBrep(text: string): Shape3D {
  const oc = getOC() as unknown as { BRepToolsWrapper: { Read(d: string): unknown } };
  let raw: unknown;
  try { raw = oc.BRepToolsWrapper.Read(text); } catch (e) { throw new Error(`not a readable BREP file (${kernelErrorMessage(e)})`); }
  const shape = cast(raw as never) as unknown as Shape3D;
  if (!isShape3D(shape as never)) throw new Error("the BREP file has no solid geometry");
  return solidsOnly(shape, "BREP file");
}

/** Read an STL (binary or ASCII) into a solid: its facets sewn into a closed
 *  shell, made a solid, then coplanar facets merged into faces. Faceted — fine
 *  for reference geometry and simple prints, not a smooth B-rep. */
export function readStl(bytes: Uint8Array): Shape3D {
  type Obj = { delete(): void };
  const oc = getOC() as unknown as {
    FS: { writeFile(p: string, d: Uint8Array): void; unlink(p: string): void };
    StlAPI_Reader: new () => { Read(s: unknown, f: string): boolean } & Obj;
    TopoDS_Shell: new () => Obj;
    BRepBuilderAPI_Sewing: new (tol: number) => { Add(s: unknown): void; Perform(): void; SewedShape(): unknown } & Obj;
    TopExp_Explorer: new (s: unknown, find: unknown) => { More(): boolean; Next(): void; Current(): unknown } & Obj;
    TopAbs_ShapeEnum: { TopAbs_SHELL: unknown };
    TopoDS: { Shell(s: unknown): unknown };
    BRepBuilderAPI_MakeSolid: new () => { Add(s: unknown): void; Solid(): unknown } & Obj;
    ShapeUpgrade_UnifySameDomain: new (s: unknown, edges: boolean, faces: boolean, concat: boolean) => { Build(): void; Shape(): unknown } & Obj;
  };
  // OCC guesses ASCII vs binary from the leading bytes, so a binary file whose
  // header and first coordinates happen to be plain ASCII (or whose header
  // starts "solid", as some exporters write) is misread. When the size matches
  // the binary layout, mark the free-form header so it reads as binary.
  const facets = bytes.length >= 84 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) : -1;
  if (facets >= 0 && bytes.length === 84 + 50 * facets) { bytes = bytes.slice(); bytes.fill(0xff, 0, 8); }
  const file = `/chisel-import-${++importSeq}.stl`;
  oc.FS.writeFile(file, bytes);
  const owned: Obj[] = [];
  const own = <T extends Obj>(x: T): T => { owned.push(x); return x; };
  try {
    const facets = own(new oc.TopoDS_Shell());
    if (!own(new oc.StlAPI_Reader()).Read(facets, file)) throw new Error("not a readable STL file");
    const sew = own(new oc.BRepBuilderAPI_Sewing(1e-6));
    sew.Add(facets);
    sew.Perform();
    const sewn = sew.SewedShape();
    const make = own(new oc.BRepBuilderAPI_MakeSolid());
    let shells = 0;
    for (const ex = own(new oc.TopExp_Explorer(sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL)); ex.More(); ex.Next()) { make.Add(oc.TopoDS.Shell(ex.Current())); shells++; }
    if (!shells) throw new Error("the STL has no closed surface");
    const unify = own(new oc.ShapeUpgrade_UnifySameDomain(make.Solid(), true, true, false));
    unify.Build();
    const solid = cast(unify.Shape() as never) as unknown as Shape3D;
    const v = volumeOfShape(solid);
    if (!Number.isFinite(v) || Math.abs(v) < 1e-12) { solid.delete(); throw new Error("the STL is not a closed mesh (no volume)"); }
    return solid;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `could not read the STL (${kernelErrorMessage(e)})`);
  } finally {
    for (const x of owned.reverse()) { try { x.delete(); } catch { /* already freed */ } }
    try { oc.FS.unlink(file); } catch { /* already gone */ }
  }
}

/** The part of a shape on the side of a plane its normal points to:
 *  (p − origin)·normal ≥ 0. Returns a NEW shape (operand untouched). */
export function keepHalfSpace(shape: Shape3D, origin: Vec3, normal: Vec3): Shape3D {
  const n = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const nz = { x: normal.x / n, y: normal.y / n, z: normal.z / n };
  // any direction across the plane will do for its x axis
  const helper = Math.abs(nz.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const xd = { x: helper.y * nz.z - helper.z * nz.y, y: helper.z * nz.x - helper.x * nz.z, z: helper.x * nz.y - helper.y * nz.x };
  const plane = new Plane([origin.x, origin.y, origin.z], [xd.x, xd.y, xd.z], [nz.x, nz.y, nz.z]);
  const out = (shape as unknown as { cutPlane(p: Plane, offset: number, keep: "positive" | "negative"): Shape3D | null }).cutPlane(plane, 0, "positive");
  if (!out) throw new Error("the cut removed the whole member");
  return out;
}

// ---- surfaces (open shells and faces, not solids) ---------------------------

type OcBuilder = { Build(): void; IsDone(): boolean; Shape(): unknown; delete(): void };
/** Run an OCC builder and take its shape (freeing the builder). */
function built(b: OcBuilder, what: string): Shape3D {
  try {
    b.Build();
    if (!b.IsDone()) throw new Error(`${what} failed in the kernel`);
    return cast(b.Shape() as never) as unknown as Shape3D;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `${what} failed (${kernelErrorMessage(e)})`);
  } finally { b.delete(); }
}
/** Several surfaces as one body. */
const asOne = (shapes: Shape3D[]): Shape3D => (shapes.length === 1 ? shapes[0] : (makeCompound(shapes as never) as unknown as Shape3D));

/** A sketch chain (open path or closed loop) as a wire on its plane. */
export function chainWire(chain: { closed: boolean; loop: Loop }, wp: WorkPlane): Wire {
  const drawing = chain.closed ? loopToDrawing(chain.loop) : openPathToDrawing(chain.loop);
  return (drawing.sketchOnPlane(planeFor(wp)) as unknown as { wire: Wire }).wire;
}

/** Surfaces swept by wires along a vector (an extruded surface; no caps). */
export function surfaceExtrude(wires: Wire[], along: Vec3, from?: Vec3): Shape3D {
  const oc = getOC() as unknown as { gp_Vec: new (x: number, y: number, z: number) => { delete(): void }; BRepPrimAPI_MakePrism: new (s: unknown, v: unknown, copy: boolean, canon: boolean) => OcBuilder };
  return asOne(wires.map((w) => {
    let wire = w as unknown as Shape3D;
    if (from && (from.x || from.y || from.z)) wire = translateShape(wire, from);
    const v = new oc.gp_Vec(along.x, along.y, along.z);
    try { return built(new oc.BRepPrimAPI_MakePrism((wire as unknown as { wrapped: unknown }).wrapped, v, false, true), "surface extrude"); }
    finally { v.delete(); if (wire !== (w as unknown as Shape3D)) wire.delete(); }
  }));
}

/** Surfaces swept by wires about an axis by `angleDeg`. */
export function surfaceRevolve(wires: Wire[], origin: Vec3, dir: Vec3, angleDeg: number): Shape3D {
  const oc = getOC() as unknown as { BRepPrimAPI_MakeRevol: new (s: unknown, ax: unknown, angle: number, copy: boolean) => OcBuilder };
  return asOne(wires.map((w) => {
    const ax = makeAx1([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z]) as unknown as { delete(): void };
    try { return built(new oc.BRepPrimAPI_MakeRevol((w as unknown as { wrapped: unknown }).wrapped, ax, (angleDeg * Math.PI) / 180, false), "surface revolve"); }
    finally { ax.delete(); }
  }));
}

/** A lofted surface through ordered wires (open or closed), not closed into a solid. */
export function surfaceLoft(wires: Wire[], ruled: boolean): Shape3D {
  if (wires.length < 2) throw new Error("a surface loft needs at least two sections");
  const oc = getOC() as unknown as { BRepOffsetAPI_ThruSections: new (solid: boolean, ruled: boolean, tol: number) => OcBuilder & { AddWire(w: unknown): void; CheckCompatibility(c: boolean): void } };
  const b = new oc.BRepOffsetAPI_ThruSections(false, ruled, 1e-6);
  for (const w of wires) b.AddWire((w as unknown as { wrapped: unknown }).wrapped);
  b.CheckCompatibility(true);
  return built(b, "surface loft");
}

/** A profile wire swept along a spine wire, as a surface. */
export function surfaceSweep(profile: Wire, spine: Wire): Shape3D {
  const oc = getOC() as unknown as { BRepOffsetAPI_MakePipe: new (spine: unknown, profile: unknown) => OcBuilder };
  return built(new oc.BRepOffsetAPI_MakePipe((spine as unknown as { wrapped: unknown }).wrapped, (profile as unknown as { wrapped: unknown }).wrapped), "surface sweep");
}

/** A flat face filling a closed planar wire (a patch). */
export function planarPatch(wire: Wire): Shape3D {
  const oc = getOC() as unknown as { BRepBuilderAPI_MakeFace: new (w: unknown, onlyPlane: boolean) => OcBuilder };
  return built(new oc.BRepBuilderAPI_MakeFace((wire as unknown as { wrapped: unknown }).wrapped, true), "patch");
}

/** A shape with no shell (a lone face) wrapped in one; anything else as is. */
function asShell(shape: unknown): unknown {
  const oc = getOC() as unknown as {
    TopExp_Explorer: new (s: unknown, find: unknown) => { More(): boolean; delete(): void };
    TopAbs_ShapeEnum: { TopAbs_SHELL: unknown };
    TopoDS_Shell: new () => unknown;
    TopoDS_Builder: new () => { MakeShell(s: unknown): void; Add(s: unknown, c: unknown): void; delete(): void };
  };
  const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
  const has = ex.More();
  ex.delete();
  if (has) return shape;
  const shell = new oc.TopoDS_Shell(), b = new oc.TopoDS_Builder();
  b.MakeShell(shell);
  b.Add(shell, shape);
  b.delete();
  return shell;
}

/** Sew shapes along shared edges (within `tol`) into one shell; with `solid`,
 *  close it into a solid — which must then have positive volume. */
export function sewShapes(shapes: Shape3D[], tol: number, solid: boolean): Shape3D {
  type Obj = { delete(): void };
  const oc = getOC() as unknown as {
    BRepBuilderAPI_Sewing: new (tol: number) => { Add(s: unknown): void; Perform(): void; SewedShape(): unknown } & Obj;
    TopExp_Explorer: new (s: unknown, find: unknown) => { More(): boolean; Next(): void; Current(): unknown } & Obj;
    TopAbs_ShapeEnum: { TopAbs_SHELL: unknown };
    TopoDS: { Shell(s: unknown): unknown };
    BRepBuilderAPI_MakeSolid: new () => { Add(s: unknown): void; Solid(): unknown } & Obj;
    BRep_Tool: { IsClosed(s: unknown): boolean };
  };
  const sew = new oc.BRepBuilderAPI_Sewing(tol);
  try {
    for (const s of shapes) sew.Add((s as unknown as { wrapped: unknown }).wrapped);
    sew.Perform();
    const sewn = sew.SewedShape();
    if (!solid) return cast(sewn as never) as unknown as Shape3D;
    const make = new oc.BRepBuilderAPI_MakeSolid();
    // a single closed face (a NURBS sphere) sews to a face, not a shell: wrap it
    const shelled = asShell(sewn);
    const ex = new oc.TopExp_Explorer(shelled, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    try {
      let shells = 0;
      for (; ex.More(); ex.Next()) {
        const shell = oc.TopoDS.Shell(ex.Current());
        // an open shell (free edges left) would make a bogus solid
        if (!oc.BRep_Tool.IsClosed(shell)) throw new Error("the stitched surfaces don't enclose a volume: there's a gap (an open edge) — add the missing surface or raise the tolerance");
        make.Add(shell);
        shells++;
      }
      if (!shells) throw new Error("the surfaces don't sew into a shell");
      const out = outwardSolid(cast(make.Solid() as never) as unknown as Shape3D);
      if (!(volumeOfShape(out) > 1e-9)) { out.delete(); throw new Error("the stitched surfaces don't enclose a volume"); }
      return out;
    } finally { ex.delete(); make.delete(); }
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `stitch failed (${kernelErrorMessage(e)})`);
  } finally { sew.delete(); }
}

/** A solid turned outward-facing if OCC built it inside-out (negative volume). */
function outwardSolid(shape: Shape3D): Shape3D {
  if (!(volumeOfShape(shape) < 0)) return shape;
  const flipped = cast((shape as unknown as { wrapped: { Reversed(): unknown } }).wrapped.Reversed() as never) as unknown as Shape3D;
  shape.delete();
  return flipped;
}

/** Thicken a surface into a solid by `t` along its normals (negative: the other side). */
export function thickenShape(shape: Shape3D, t: number): Shape3D {
  const oc = getOC() as unknown as { BRepOffsetAPI_MakeThickSolid: new () => OcBuilder & { MakeThickSolidBySimple(s: unknown, off: number): void } };
  const b = new oc.BRepOffsetAPI_MakeThickSolid();
  b.MakeThickSolidBySimple((shape as unknown as { wrapped: unknown }).wrapped, t);
  return outwardSolid(built(b, "thicken"));
}

/** Offset a surface by `d` along its normals (a parallel surface). */
export function offsetSurface(shape: Shape3D, d: number): Shape3D {
  const oc = getOC() as unknown as { BRepOffsetAPI_MakeOffsetShape: new () => OcBuilder & { PerformBySimple(s: unknown, off: number): void } };
  const b = new oc.BRepOffsetAPI_MakeOffsetShape();
  b.PerformBySimple((shape as unknown as { wrapped: unknown }).wrapped, d);
  return built(b, "offset");
}

/** Untrim: rebuild every face from its own surface and outer boundary, so the
 *  holes trimmed into it are filled; the faces are sewn back together. */
export function untrimFaces(shape: Shape3D): Shape3D {
  const oc = getOC() as unknown as {
    BRep_Tool: { Surface(f: unknown): unknown };
    BRepTools: { OuterWire(f: unknown): unknown };
    BRepBuilderAPI_MakeFace: new (s: unknown, w: unknown, inside: boolean) => OcBuilder;
  };
  const faces = facesOf(shape);
  try {
    const rebuilt = faces.map((f) => built(new oc.BRepBuilderAPI_MakeFace(oc.BRep_Tool.Surface(f.wrapped), oc.BRepTools.OuterWire(f.wrapped), true), "untrim"));
    return rebuilt.length === 1 ? rebuilt[0] : sewShapes(rebuilt, 1e-6, false);
  } finally { freeAll(faces); }
}

/** Whether a shape holds any solid (else it's a surface body: shells / faces). */
export function hasSolid(shape: Shape3D): boolean {
  const solids = (shape as unknown as { solids?: { delete(): void }[] }).solids ?? [];
  freeAll(solids);
  return solids.length > 0;
}

// ---- exact NURBS B-reps (imported Rhino geometry) -----------------------------

type OcAny = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** OCC arrays (1-based) from plain numbers. */
function ocCurve(oc: OcAny, c: NurbsCurveData): OcAny {
  const n = c.poles.length / 3;
  const poles = new oc.NCollection_Array1_gp_Pnt(1, n);
  const weights = new oc.NCollection_Array1_double(1, n);
  for (let i = 0; i < n; i++) {
    const p = new oc.gp_Pnt(c.poles[3 * i], c.poles[3 * i + 1], c.poles[3 * i + 2]);
    poles.SetValue(i + 1, p); p.delete();
    weights.SetValue(i + 1, c.weights?.[i] ?? 1);
  }
  const { knots, mults } = knotMults(c.knots);
  const K = new oc.NCollection_Array1_double(1, knots.length), M = new oc.NCollection_Array1_int(1, knots.length);
  knots.forEach((k, i) => { K.SetValue(i + 1, k); M.SetValue(i + 1, mults[i]); });
  try { return new oc.Geom_BSplineCurve(poles, weights, K, M, c.degree, false, true); }
  finally { poles.delete(); weights.delete(); K.delete(); M.delete(); }
}

function ocSurface(oc: OcAny, s: NurbsSurfaceData): OcAny {
  const poles = new oc.NCollection_Array2_gp_Pnt(1, s.countU, 1, s.countV);
  const weights = new oc.NCollection_Array2_double(1, s.countU, 1, s.countV);
  for (let i = 0; i < s.countU; i++) for (let j = 0; j < s.countV; j++) {
    const k = i * s.countV + j;
    const p = new oc.gp_Pnt(s.poles[3 * k], s.poles[3 * k + 1], s.poles[3 * k + 2]);
    poles.SetValue(i + 1, j + 1, p); p.delete();
    weights.SetValue(i + 1, j + 1, s.weights?.[k] ?? 1);
  }
  const arr = (flat: number[]) => {
    const { knots, mults } = knotMults(flat);
    const K = new oc.NCollection_Array1_double(1, knots.length), M = new oc.NCollection_Array1_int(1, knots.length);
    knots.forEach((k, i) => { K.SetValue(i + 1, k); M.SetValue(i + 1, mults[i]); });
    return { K, M };
  };
  const u = arr(s.knotsU), v = arr(s.knotsV);
  let surf: OcAny;
  try { surf = new oc.Geom_BSplineSurface(poles, weights, u.K, v.K, u.M, v.M, s.degreeU, s.degreeV, false, false); }
  finally { poles.delete(); weights.delete(); u.K.delete(); u.M.delete(); v.K.delete(); v.M.delete(); }
  // A surface that meets itself (a full turn: a sphere, a cylinder's side) is
  // made periodic, so its face gets a real seam instead of two loose edges.
  try { if (surf.IsUClosed()) surf.SetUPeriodic(); } catch { /* not periodic-compatible: keep it clamped */ }
  try { if (surf.IsVClosed()) surf.SetVPeriodic(); } catch { /* likewise */ }
  return surf;
}

/** Whether every edge of a face's loops runs along its surface's own
 *  boundary (iso-lines at the ends of the u/v ranges) — then the face is just
 *  the surface's natural extent, which OCC builds cleanly with its seams and
 *  poles; only a genuinely trimmed face is built from its edges. */
function onNaturalBoundary(oc: OcAny, surf: OcAny, curves: OcAny[], face: NurbsFaceData): boolean {
  const b = surf.Bounds(0, 0, 0, 0) as { U1: number; U2: number; V1: number; V2: number };
  const [u0, u1, v0, v1] = [b.U1, b.U2, b.V1, b.V2];
  const tu = 1e-6 * Math.max(1, Math.abs(u1 - u0)), tv = 1e-6 * Math.max(1, Math.abs(v1 - v0));
  for (const loop of face.loops) for (const t of loop.trims) {
    const c = curves[t.curve];
    const a = c.FirstParameter(), b = c.LastParameter();
    for (const f of [0.17, 0.5, 0.83]) {
      const p = c.Value(a + (b - a) * f);
      const proj = new oc.GeomAPI_ProjectPointOnSurf(p, surf);
      try {
        if (proj.NbPoints() < 1) return false;
        const { U, V } = proj.LowerDistanceParameters();
        if (!(Math.abs(U - u0) < tu || Math.abs(U - u1) < tu || Math.abs(V - v0) < tv || Math.abs(V - v1) < tv)) return false;
      } finally { proj.delete(); p.delete(); }
    }
  }
  return true;
}

/** Build a solid (or, when it doesn't close, a shell) from exact NURBS B-rep data. */
export function readNurbsBrep(text: string): Shape3D {
  const data = JSON.parse(text) as NurbsBrepData;
  const oc = getOC() as OcAny;
  const curves = data.curves.map((c) => ocCurve(oc, c));
  const faces: Shape3D[] = [];
  try {
    for (const fd of data.faces) {
      const surf = ocSurface(oc, fd.surface);
      let face: OcAny;
      if (onNaturalBoundary(oc, surf, curves, fd)) {
        const mk = new oc.BRepBuilderAPI_MakeFace(surf, 1e-6);
        try { face = mk.Face(); } finally { mk.delete(); }
      } else {
        // a trimmed face: wires of its edges in loop order (the fixer joins
        // them within tolerance and adds their curves on the surface)
        const builder = new oc.TopoDS_Builder();
        const wires = fd.loops.map((loop) => {
          const w = new oc.TopoDS_Wire();
          builder.MakeWire(w);
          for (const t of loop.trims) {
            const mkE = new oc.BRepBuilderAPI_MakeEdge(curves[t.curve]);
            const e = mkE.Edge();
            builder.Add(w, t.reversed ? e.Reversed() : e);
            mkE.delete();
          }
          return w;
        });
        const outer = fd.loops.findIndex((l) => l.outer);
        const mk = new oc.BRepBuilderAPI_MakeFace(surf, wires[outer >= 0 ? outer : 0], true);
        wires.forEach((w, i) => { if (i !== (outer >= 0 ? outer : 0)) mk.Add(w); });
        const raw = mk.Face();
        mk.delete(); builder.delete();
        const fix = new oc.ShapeFix_Face(raw);
        fix.SetPrecision(data.tolerance);
        fix.Perform();
        fix.FixOrientation(); // an outer loop traced the wrong way would make the face its own complement
        face = fix.Face();
        fix.delete();
      }
      faces.push(cast((fd.reversed ? face.Reversed() : face) as never) as unknown as Shape3D);
    }
    if (!faces.length) throw new Error("the B-rep has no faces");
    const tol = Math.max(1e-6, data.tolerance);
    if (data.solid) {
      try { return sewShapes(faces, tol, true); } catch { /* not watertight after all: keep it as a shell */ }
    }
    return faces.length === 1 ? faces[0] : sewShapes(faces, tol, false);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `could not rebuild the NURBS geometry (${kernelErrorMessage(e)})`);
  }
}

/** Minimum distance between two shapes (0 when they touch or overlap). */
export function distanceBetween(a: Shape3D, b: Shape3D): number {
  return measureDistanceBetween(a as never, b as never);
}

// ---- surface quality analysis (curvature, continuity, combs) ----------------
//
// The build has no LProp classes, so curvature comes straight from the
// adaptors' derivatives: principal curvatures from the first and second
// fundamental forms of a face, and an edge's curvature from |r'×r''|/|r'|³.
// Sign convention: positive = convex (curving away from the outward normal).

type OcVec = { X(): number; Y(): number; Z(): number; delete(): void };
interface OcAnalysis {
  gp_Pnt: new (x?: number, y?: number, z?: number) => OcVec;
  gp_Vec: new () => OcVec;
  BRepAdaptor_Surface: new (f: unknown, restriction?: boolean) => { D2(u: number, v: number, p: OcVec, su: OcVec, sv: OcVec, suu: OcVec, svv: OcVec, suv: OcVec): void; delete(): void };
  BRepAdaptor_Curve: new (e: unknown) => { FirstParameter(): number; LastParameter(): number; D2(t: number, p: OcVec, d1: OcVec, d2: OcVec): void; delete(): void };
  GeomAPI_ProjectPointOnSurf: new (p: OcVec, s: unknown) => { NbPoints(): number; LowerDistanceParameters(): { U: number; V: number }; delete(): void };
  BRep_Tool: { Surface(f: unknown): unknown };
  TopAbs_Orientation: { TopAbs_REVERSED: unknown };
}
type V3 = [number, number, number];
const v3 = (v: OcVec): V3 => [v.X(), v.Y(), v.Z()];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** Differential geometry of a face at (u,v): outward unit normal, the
 *  fundamental forms, and principal curvatures (k1 ≥ k2, convex positive). */
interface SurfacePoint { p: V3; n: V3; su: V3; sv: V3; E: number; F: number; G: number; L: number; M: number; N: number; k1: number; k2: number }

function surfacePoint(ad: InstanceType<OcAnalysis["BRepAdaptor_Surface"]>, oc: OcAnalysis, u: number, v: number, reversed: boolean): SurfacePoint | undefined {
  const P = new oc.gp_Pnt(), Su = new oc.gp_Vec(), Sv = new oc.gp_Vec(), Suu = new oc.gp_Vec(), Svv = new oc.gp_Vec(), Suv = new oc.gp_Vec();
  try {
    ad.D2(u, v, P, Su, Sv, Suu, Svv, Suv);
    const su = v3(Su), sv = v3(Sv), suu = v3(Suu), svv = v3(Svv), suv = v3(Suv);
    const c = cross3(su, sv), m = len3(c);
    if (!(m > 1e-14)) return undefined; // a singular point (a cone apex, a sphere pole)
    // outward normal; with it, a convex surface has negative L/M/N — flip so convex reads positive
    const n = scale3(c, (reversed ? -1 : 1) / m);
    const E = dot3(su, su), F = dot3(su, sv), G = dot3(sv, sv);
    const L = -dot3(suu, n), M = -dot3(suv, n), N = -dot3(svv, n);
    const det = E * G - F * F;
    const K = (L * N - M * M) / det, H = (E * N - 2 * F * M + G * L) / (2 * det);
    const r = Math.sqrt(Math.max(0, H * H - K));
    return { p: v3(P), n, su, sv, E, F, G, L, M, N, k1: H + r, k2: H - r };
  } finally { for (const x of [P, Su, Sv, Suu, Svv, Suv]) x.delete(); }
}

/** Normal curvature of a face along tangent direction d (convex positive). */
function normalCurvature(sp: SurfacePoint, d: V3): number {
  // d = a·Su + b·Sv (least squares in the tangent plane)
  const r1 = dot3(d, sp.su), r2 = dot3(d, sp.sv), det = sp.E * sp.G - sp.F * sp.F;
  const a = (sp.G * r1 - sp.F * r2) / det, b = (sp.E * r2 - sp.F * r1) / det;
  const I = sp.E * a * a + 2 * sp.F * a * b + sp.G * b * b;
  return I > 0 ? (sp.L * a * a + 2 * sp.M * a * b + sp.N * b * b) / I : 0;
}

export interface BodyAnalysis {
  /** Principal curvatures (k1, k2) per vertex of meshShape(shape), 1/mm, convex positive. */
  curvature: Float32Array;
  /** Curvature-comb line segments (flat xyz pairs): teeth along each curved edge and the line joining their tips. */
  combs: Float32Array;
  /** Continuity across every edge shared by two faces: G0 (a crease), G1 (tangent), G2 (curvature-continuous). */
  edges: { edge: number; faces: [number, number]; continuity: "G0" | "G1" | "G2"; angleDeg: number; curvatureJump: number }[];
  /** Ranges over the mesh vertices. */
  stats: { kMin: number; kMax: number; meanMin: number; meanMax: number; gaussMin: number; gaussMax: number };
}

/** Curvature per display-mesh vertex, edge continuity and curvature combs for one solid. */
export function analyzeShape(shape: Shape3D, mesh: SolidMesh, opts: { combs?: boolean; combTeeth?: number } = {}): BodyAnalysis {
  const oc = getOC() as unknown as OcAnalysis;
  const faces = facesOf(shape), edges = edgesOf(shape);
  const adaptors = faces.map((f) => new oc.BRepAdaptor_Surface(f.wrapped, true));
  const surfaces = faces.map((f) => oc.BRep_Tool.Surface(f.wrapped));
  const reversed = faces.map((f) => (f.wrapped as unknown as { Orientation(): unknown }).Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED);
  const planar = faces.map((f) => String(f.geomType).toUpperCase() === "PLANE");
  /** The face's differential geometry at the point of it nearest to (x,y,z). */
  const at = (fi: number, x: number, y: number, z: number): SurfacePoint | undefined => {
    const P = new oc.gp_Pnt(x, y, z);
    try {
      const proj = new oc.GeomAPI_ProjectPointOnSurf(P, surfaces[fi]);
      try {
        if (proj.NbPoints() < 1) return undefined;
        const { U, V } = proj.LowerDistanceParameters();
        return surfacePoint(adaptors[fi], oc, U, V, reversed[fi]);
      } finally { proj.delete(); }
    } catch { return undefined; } finally { P.delete(); }
  };
  try {
    // ---- per-vertex principal curvature (each face's vertices are its own)
    const nv = mesh.positions.length / 3;
    const curvature = new Float32Array(nv * 2);
    const ranges = mesh.faceRanges ?? [];
    const singular = new Set<number>(); // vertices where curvature is undefined (a pole, an apex)
    for (let fi = 0; fi * 2 < ranges.length && fi < faces.length; fi++) {
      if (planar[fi]) continue;
      const seen = new Set<number>();
      let s1 = 0, s2 = 0, n = 0;
      for (let k = ranges[2 * fi]; k < ranges[2 * fi] + ranges[2 * fi + 1]; k++) {
        const vi = mesh.indices[k];
        if (seen.has(vi)) continue;
        seen.add(vi);
        const sp = at(fi, mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]);
        if (sp) { curvature[vi * 2] = sp.k1; curvature[vi * 2 + 1] = sp.k2; s1 += sp.k1; s2 += sp.k2; n++; }
        else singular.add(vi);
      }
      // show a singular vertex with its face's average (it doesn't count in the stats)
      for (const vi of seen) if (singular.has(vi) && n) { curvature[vi * 2] = s1 / n; curvature[vi * 2 + 1] = s2 / n; }
    }
    const stats = { kMin: Infinity, kMax: -Infinity, meanMin: Infinity, meanMax: -Infinity, gaussMin: Infinity, gaussMax: -Infinity };
    for (let i = 0; i < nv; i++) {
      if (singular.has(i)) continue;
      const k1 = curvature[i * 2], k2 = curvature[i * 2 + 1];
      stats.kMin = Math.min(stats.kMin, k2); stats.kMax = Math.max(stats.kMax, k1);
      stats.meanMin = Math.min(stats.meanMin, (k1 + k2) / 2); stats.meanMax = Math.max(stats.meanMax, (k1 + k2) / 2);
      stats.gaussMin = Math.min(stats.gaussMin, k1 * k2); stats.gaussMax = Math.max(stats.gaussMax, k1 * k2);
    }
    if (!Number.isFinite(stats.kMin)) for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;

    // ---- edges: continuity across the two faces, and combs along the curve
    const adjacency = edgeGeoms(shape);
    const out: BodyAnalysis["edges"] = [];
    const teeth: { p: V3; c: V3 }[][] = [];
    const nTeeth = Math.max(4, opts.combTeeth ?? 14);
    edges.forEach((e, ei) => {
      const curve = new oc.BRepAdaptor_Curve(e.wrapped);
      const P = new oc.gp_Pnt(), D1 = new oc.gp_Vec(), D2 = new oc.gp_Vec();
      try {
        const t0 = curve.FirstParameter(), t1 = curve.LastParameter();
        const sample = (t: number) => { curve.D2(t, P, D1, D2); return { p: v3(P), d1: v3(D1), d2: v3(D2) }; };
        const fs = [...new Set(adjacency[ei]?.faces ?? [])];
        if (fs.length === 2) {
          let angle = 0, jump = 0, kSide = 0;
          for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const { p, d1 } = sample(t0 + (t1 - t0) * f);
            const T = scale3(d1, 1 / (len3(d1) || 1));
            const a = at(fs[0], ...p), b = at(fs[1], ...p);
            if (!a || !b) continue;
            angle = Math.max(angle, (Math.acos(Math.max(-1, Math.min(1, dot3(a.n, b.n)))) * 180) / Math.PI);
            const ka = normalCurvature(a, cross3(a.n, T)), kb = normalCurvature(b, cross3(b.n, T));
            jump = Math.max(jump, Math.abs(ka - kb));
            kSide = Math.max(kSide, Math.abs(ka), Math.abs(kb));
          }
          // tangent within half a degree is G1; the cross-edge curvature also matching (to 1%) is G2
          out.push({ edge: ei, faces: [fs[0], fs[1]], continuity: angle > 0.5 ? "G0" : jump > 1e-6 + 0.01 * kSide ? "G1" : "G2", angleDeg: angle, curvatureJump: jump });
        }
        if (opts.combs) {
          const row: { p: V3; c: V3 }[] = [];
          for (let i = 0; i <= nTeeth; i++) {
            const { p, d1, d2 } = sample(t0 + ((t1 - t0) * i) / nTeeth);
            const s = len3(d1);
            if (!(s > 1e-12)) continue;
            const k = len3(cross3(d1, d2)) / (s * s * s);
            const T = scale3(d1, 1 / s);
            const nrm = [d2[0] - dot3(d2, T) * T[0], d2[1] - dot3(d2, T) * T[1], d2[2] - dot3(d2, T) * T[2]] as V3;
            const nl = len3(nrm);
            row.push({ p, c: k > 1e-9 && nl > 1e-12 ? scale3(nrm, -k / nl) : [0, 0, 0] }); // teeth point away from the centre of curvature
          }
          if (row.some((r) => len3(r.c) > 0)) teeth.push(row);
        }
      } finally { P.delete(); D1.delete(); D2.delete(); curve.delete(); }
    });
    // the largest tooth spans 8% of the body's diagonal
    let maxK = 0;
    for (const row of teeth) for (const t of row) maxK = Math.max(maxK, len3(t.c));
    const xs = mesh.positions;
    let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < xs.length; i += 3) { lo = [Math.min(lo[0], xs[i]), Math.min(lo[1], xs[i + 1]), Math.min(lo[2], xs[i + 2])]; hi = [Math.max(hi[0], xs[i]), Math.max(hi[1], xs[i + 1]), Math.max(hi[2], xs[i + 2])]; }
    const scale = maxK > 0 ? (0.08 * Math.max(1e-9, len3([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]))) / maxK : 0;
    const seg: number[] = [];
    for (const row of teeth) {
      const tip = row.map((t) => [t.p[0] + t.c[0] * scale, t.p[1] + t.c[1] * scale, t.p[2] + t.c[2] * scale] as V3);
      row.forEach((t, i) => { if (len3(t.c) > 0) seg.push(...t.p, ...tip[i]); if (i > 0) seg.push(...tip[i - 1], ...tip[i]); });
    }
    return { curvature, combs: Float32Array.from(seg), edges: out, stats };
  } finally {
    for (const a of adaptors) a.delete();
    freeAll(edges); freeAll(faces);
  }
}

/** Exact (B-rep, not mesh) mass properties of a solid: volume (mm³), surface
 *  area (mm²) and the centroid of its volume, by Gauss integration over the
 *  faces. NaN fields if OCC can't integrate the shape. */
export interface MassProps { volume: number; area: number; centroid: Vec3 }

export function massPropsOfShape(shape: Shape3D): MassProps {
  const oc = getOC() as unknown as {
    GProp_GProps: new () => { Mass(): number; CentreOfMass(): { X(): number; Y(): number; Z(): number; delete(): void }; delete(): void };
    BRepGProp: { VolumeProperties(s: unknown, p: unknown, eps: number, onlyClosed: boolean, skipShared: boolean): number; SurfaceProperties(s: unknown, p: unknown, eps: number, skipShared: boolean): number };
  };
  const wrapped = (shape as unknown as { wrapped: unknown }).wrapped;
  const vp = new oc.GProp_GProps(), sp = new oc.GProp_GProps();
  try {
    // adaptive (error-bounded) integration: the fixed-order rule is off by
    // ~0.2% on rational B-spline surfaces (an imported NURBS sphere)
    oc.BRepGProp.VolumeProperties(wrapped, vp, 1e-9, false, false);
    oc.BRepGProp.SurfaceProperties(wrapped, sp, 1e-9, false);
    const c = vp.CentreOfMass();
    try { return { volume: vp.Mass(), area: sp.Mass(), centroid: { x: c.X(), y: c.Y(), z: c.Z() } }; } finally { c.delete(); }
  } catch {
    return { volume: NaN, area: NaN, centroid: { x: NaN, y: NaN, z: NaN } };
  } finally {
    vp.delete(); sp.delete();
  }
}
