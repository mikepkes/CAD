// OpenCASCADE kernel wrapper (via replicad). The ONLY module that imports
// replicad/OCCT, so the rest of the system stays kernel-agnostic. Turns a
// renderer-agnostic Profile on a WorkPlane into a solid: a tessellated mesh for
// display, and STL/STEP blobs for CNC / 3D-print output.

import opencascade from "replicad-opencascadejs";
import { setOC, draw, drawCircle, Plane, type Drawing, type Shape3D } from "replicad";
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

/** Extrude a profile and return its B-rep edges, classified + sampled. Frees the shape. */
export function extrudeToEdges(wp: WorkPlane, profile: Profile, distance: number): Edge3D[] {
  const solid = buildSolid(wp, profile, distance);
  try {
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
  } finally {
    solid.delete();
  }
}

/** Extrude a profile and return an STL or STEP blob. Frees the OCC shape. */
export function extrudeToBlob(wp: WorkPlane, profile: Profile, distance: number, format: "stl" | "step"): Blob {
  const solid = buildSolid(wp, profile, distance);
  try {
    return format === "stl" ? solid.blobSTL({ binary: true }) : solid.blobSTEP();
  } finally {
    solid.delete();
  }
}
