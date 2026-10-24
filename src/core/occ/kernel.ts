// OpenCASCADE kernel wrapper (via replicad). The ONLY module that imports
// replicad/OCCT, so the rest of the system stays kernel-agnostic. Turns a
// renderer-agnostic Profile on a WorkPlane into a solid: a tessellated mesh for
// display, and STL/STEP blobs for CNC / 3D-print output.

import opencascade from "replicad-opencascadejs";
import { setOC, draw, drawCircle, drawEllipse, Plane, type Drawing, type Shape3D } from "replicad";
import { WorkPlane } from "../../geometry/plane";
import { Loop, Profile } from "../geometry/profile";

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
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (s.kind === "line") pen = pen.lineTo([s.to.x, s.to.y]);
    else pen = pen.threePointsArcTo([s.to.x, s.to.y], [s.via.x, s.via.y]);
  }
  // Final segment closes the loop.
  const last = segs[segs.length - 1];
  if (last && last.kind === "arc") pen = pen.threePointsArcTo([last.to.x, last.to.y], [last.via.x, last.via.y]);
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

/** Boolean-combine two solids. Consumes neither operand (caller frees them). */
export function fuseShapes(a: Shape3D, b: Shape3D): Shape3D {
  return (a as unknown as { fuse: (o: Shape3D, opts?: unknown) => Shape3D }).fuse(b);
}
export function cutShapes(base: Shape3D, tool: Shape3D): Shape3D {
  return (base as unknown as { cut: (o: Shape3D, opts?: unknown) => Shape3D }).cut(tool);
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
