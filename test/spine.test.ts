// A sweep along a 3D spine: the spline math (src/core/geometry/spine.ts), the
// kernel's pipe-shell sweep with a scale law or several sections, and the
// wrapped texture coordinates a grip pattern is drawn with.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, analyzeBodies, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { placeComponentSketches } from "../src/core/recompute";
import { controlSpine, throughSpine, curveDerivs, spineTable, paramAtLength, sectionPlane, easedLaw } from "../src/core/geometry/spine";
import { wrapCoords, wrapsTexture } from "../src/viewport/material";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const P = (x: number, y: number, z: number) => ({ x, y, z });
const curvature = (d1: { x: number; y: number; z: number }, d2: { x: number; y: number; z: number }) => {
  const c = [d1.y * d2.z - d1.z * d2.y, d1.z * d2.x - d1.x * d2.z, d1.x * d2.y - d1.y * d2.x];
  return Math.hypot(c[0], c[1], c[2]) / Math.hypot(d1.x, d1.y, d1.z) ** 3;
};

describe("3D spine", () => {
  const poly = [P(0, 0, 0), P(40, 0, 0), P(80, 0, 0), P(120, 0, 0), P(160, 30, 20), P(200, 60, 40), P(240, 60, 40), P(280, 60, 40), P(320, 60, 40)];

  it("a control polygon: clamped at its ends, straight along four collinear points, curvature-continuous in the bends", () => {
    const c = controlSpine(poly);
    expect(curveDerivs(c, 0).p).toEqual(P(0, 0, 0));
    const end = curveDerivs(c, 1).p;
    expect(end.x).toBeCloseTo(320, 9); expect(end.y).toBeCloseTo(60, 9); expect(end.z).toBeCloseTo(40, 9);
    // the first span (poles 0–3 collinear on the x axis) is exactly straight
    const firstSpan = c.knots[4];
    for (const t of [0, firstSpan / 3, firstSpan * 0.99]) { const q = curveDerivs(c, t); expect(Math.abs(q.p.y) + Math.abs(q.p.z)).toBeLessThan(1e-9); expect(curvature(q.d1, q.d2)).toBeLessThan(1e-9); }
    // across every interior knot: tangent and curvature agree from both sides (G2)
    for (const k of [...new Set(c.knots)].filter((k) => k > 0 && k < 1)) {
      const a = curveDerivs(c, k - 1e-7), b = curveDerivs(c, k + 1e-7);
      expect(Math.abs(curvature(a.d1, a.d2) - curvature(b.d1, b.d2))).toBeLessThan(1e-5);
    }
  });

  it("through points: passes through each, C2", () => {
    const pts = [P(0, 0, 0), P(50, 10, 5), P(100, -10, 20), P(150, 0, 30)];
    const c = throughSpine(pts);
    const tab = spineTable(c);
    // each point is on the curve (the nearest sample is within a hair)
    for (const q of pts) {
      let best = Infinity;
      for (let i = 0; i <= 2000; i++) { const p = curveDerivs(c, i / 2000).p; best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)); }
      expect(best).toBeLessThan(0.1);
    }
    expect(tab.length).toBeGreaterThan(150);
  });

  it("measures arc length and places sections square to it, upright", () => {
    const c = controlSpine([P(0, 0, 0), P(100, 0, 0)]);
    const tab = spineTable(c);
    expect(tab.length).toBeCloseTo(100, 6);
    expect(curveDerivs(c, paramAtLength(tab, 25)).p.x).toBeCloseTo(25, 6);
    const wp = sectionPlane(c, 0.5, P(0, 0, 1));
    expect(wp.normal.x).toBeCloseTo(1, 9); expect(wp.v.z).toBeCloseTo(1, 9); expect(wp.u.y).toBeCloseTo(1, 9);
    // running straight up `up`: still a frame (u carried, square to the spine)
    const up = sectionPlane(controlSpine([P(0, 0, 0), P(0, 0, 50)]), 0.5, P(0, 0, 1));
    expect(Math.abs(up.u.x * up.normal.x + up.u.y * up.normal.y + up.u.z * up.normal.z)).toBeLessThan(1e-9);
  });

  it("an eased law holds equal neighbours exactly and never overshoots", () => {
    const f = easedLaw([{ at: 0, value: 0.7 }, { at: 100, value: 0.7 }, { at: 200, value: 1 }, { at: 300, value: 1 }]);
    expect(f(-5)).toBe(0.7); expect(f(50)).toBe(0.7); expect(f(250)).toBe(1); expect(f(400)).toBe(1);
    let prev = 0.7;
    for (let s = 100; s <= 200; s += 1) { const v = f(s); expect(v).toBeGreaterThanOrEqual(prev - 1e-12); expect(v).toBeLessThanOrEqual(1 + 1e-12); prev = v; }
    // flat (zero slope) at the stations: C1 and C2 joins
    expect(Math.abs(f(100.01) - f(100)) / 0.01).toBeLessThan(1e-4);
  });
});

describe("feature.sweep along a 3D path", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  async function dis(s: CadSession, type: string, params: Record<string, unknown>) { const r = await s.dispatch(type, params); if (!r.ok) throw new Error(`${type}: ${r.error}`); return r.createdIds ?? []; }
  function solids(s: CadSession): SolidEval[] {
    const scope = resolveParameters(s.doc.parameters).scope;
    placeComponentSketches(s.doc, scope);
    return Object.values(evaluateFeatures(s.doc, scope));
  }
  /** Largest distance of the mesh's vertices from the x axis within `half` of x = x0. */
  const rAt = (b: SolidEval, x0: number, half = 1) => { const p = b.mesh!.positions; let r = 0; for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i] - x0) <= half) r = Math.max(r, Math.hypot(p[i + 1], p[i + 2])); return r; };

  it("tapers a tube with a scale law: exact at the stations, smooth between, its length a parameter", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "len", expression: "300", min: 200, max: 400 });
    const frame = (await dis(s, "sketch.create", { plane: "XY" }))[0];
    const prof = (await dis(s, "sketch.create", { plane: "YZ" }))[0];
    await dis(s, "sketch.addRing", { sketch: prof, center: { x: 0, y: 0 }, outerRadius: 15.9, innerRadius: 14.1 });
    const id = (await dis(s, "feature.sweep", {
      profile: prof, path: frame, points: [{ x: 0, y: 0, z: 0 }, { x: "len/3", y: 0, z: 0 }, { x: "2*len/3", y: 0, z: 0 }, { x: "len", y: 0, z: 0 }],
      scale: [{ at: 0, value: 1 }, { at: 80, value: 1 }, { at: "pathLength-80", value: 0.698 }, { at: "pathLength", value: 0.698 }],
    }))[0];
    let b = solids(s).find((x) => x.featureId === id)!;
    expect(b.error).toBeUndefined();
    expect(rAt(b, 40)).toBeCloseTo(15.9, 1);
    expect(rAt(b, 260)).toBeCloseTo(15.9 * 0.698, 1);
    const mid = rAt(b, 150);
    expect(mid).toBeGreaterThan(11.2); expect(mid).toBeLessThan(15.8);
    expect(b.bounds!.max.x).toBeCloseTo(300, 1);
    await dis(s, "parameter.set", { name: "len", expression: "400" });
    b = solids(s).find((x) => x.featureId === id)!;
    expect(b.bounds!.max.x).toBeCloseTo(400, 1);
    expect(rAt(b, 360)).toBeCloseTo(15.9 * 0.698, 1);
    // drawn like a smooth part: no edge line down its seam (only the end rims), and no shading
    // crease there either (the two sides of the seam share their normals)
    const E = b.mesh!.edges;
    for (let i = 0; i < E.length; i += 6) expect(Math.abs(E[i + 3] - E[i]), "an edge segment runs along the tube").toBeLessThan(1);
    const P = b.mesh!.positions, N = b.mesh!.normals, seen = new Map<string, number>();
    let shared = 0;
    for (let i = 0; i < P.length / 3; i++) {
      const k = `${P[3 * i].toFixed(3)},${P[3 * i + 1].toFixed(3)},${P[3 * i + 2].toFixed(3)}`, j = seen.get(k);
      if (j === undefined) { seen.set(k, i); continue; }
      const d = N[3 * i] * N[3 * j] + N[3 * i + 1] * N[3 * j + 1] + N[3 * i + 2] * N[3 * j + 2];
      if (d > 0.9) { shared++; expect(d).toBeGreaterThan(1 - 1e-6); }
    }
    expect(shared).toBeGreaterThan(10);
    // the swept surface is curvature-continuous across its seams
    const a = analyzeBodies(s.doc, resolveParameters(s.doc.parameters).scope).find((x) => x.featureId === id)!;
    for (const e of a.edges.filter((e) => e.angleDeg < 45)) expect(e.continuity).toBe("G2");
  }, 120000);

  it("morphs between sections (a round end into a winged one), in the frame sketch's component", async () => {
    const s = realSession();
    const comp = (await dis(s, "component.create", { name: "Grip" }))[0];
    const frame = (await dis(s, "sketch.create", { plane: "XY", component: comp }))[0];
    const a = (await dis(s, "sketch.create", { plane: "YZ", component: comp }))[0];
    await dis(s, "sketch.addCircle", { sketch: a, center: { x: 0, y: 0 }, radius: 15 });
    const b = (await dis(s, "sketch.create", { plane: "YZ", component: comp }))[0];
    await dis(s, "sketch.addEllipse", { sketch: b, center: { x: -8, y: 0 }, rx: 24, ry: 15 });
    const id = (await dis(s, "feature.sweep", { path: frame, points: [{ x: 0, y: 0, z: 0 }, { x: 120, y: 0, z: 0 }], sections: [{ sketch: a, at: 0 }, { sketch: b, at: "pathLength" }] }))[0];
    const body = solids(s).find((x) => x.featureId === id)!;
    expect(body.error).toBeUndefined();
    expect(s.doc.sketches[body.sketchId]?.componentId).toBe(comp); // the body is the component's (its material, its visibility)
    // round at the start; at the end the wing reaches back 8 + 24 = 32 mm (u is +y along +x, so back is −y)
    const p = body.mesh!.positions;
    let yMinStart = 0, yMinEnd = 0;
    for (let i = 0; i < p.length; i += 3) { if (p[i] < 1) yMinStart = Math.min(yMinStart, p[i + 1]); if (p[i] > 119) yMinEnd = Math.min(yMinEnd, p[i + 1]); }
    expect(yMinStart).toBeCloseTo(-15, 0);
    expect(yMinEnd).toBeCloseTo(-32, 0);
  }, 120000);

  it("refuses what it can't do", async () => {
    const s = realSession();
    const frame = (await dis(s, "sketch.create", { plane: "XY" }))[0];
    const prof = (await dis(s, "sketch.create", { plane: "YZ" }))[0];
    await dis(s, "sketch.addCircle", { sketch: prof, center: { x: 0, y: 0 }, radius: 5 });
    expect((await s.dispatch("feature.sweep", { profile: prof, path: frame, scale: [{ at: 0, value: 1 }] })).ok).toBe(false); // a law needs a 3D path
    expect((await s.dispatch("feature.sweep", { profile: prof, path: frame, points: [{ x: 0, y: 0, z: "(1+" }, { x: 1, y: 0, z: 0 }] })).ok).toBe(false);
    expect((await s.dispatch("feature.sweep", { path: frame, points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], sections: [{ sketch: prof, at: 0 }, { sketch: prof, at: 1 }], scale: [{ at: 0, value: 1 }] })).ok).toBe(false);
  });
});

describe("wrapped texture coordinates", () => {
  /** A tube along x with an elliptical, off-centre section (a winged grip), as a vertex grid. */
  function tube(rx: number, ry: number, n = 160, m = 40, len = 120): Float32Array {
    const out: number[] = [];
    for (let j = 0; j <= m; j++) for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; out.push((len * j) / m, -6 + rx * Math.cos(a), 2 + ry * Math.sin(a)); }
    return Float32Array.from(out);
  }

  it("wraps by arc length: equal steps round a winged section, and it closes on itself", () => {
    const pos = tube(25, 15);
    const w = wrapCoords(pos);
    const n = 160, ring = 20; // a ring of vertices mid-way along
    const ang = (k: number) => Math.atan2(w[4 * k + 1], w[4 * k]);
    // the girth is the ellipse's perimeter (Ramanujan)
    const h = ((25 - 15) / (25 + 15)) ** 2, per = Math.PI * (25 + 15) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    expect(w[4 * (ring * n) + 3]).toBeCloseTo(per, -0.5);
    // arc length between neighbours ∝ the step in the wrapped angle
    const steps: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = ring * n + i, k2 = ring * n + ((i + 1) % n);
      let d = ang(k2) - ang(k); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      const arc = Math.hypot(pos[3 * k2 + 1] - pos[3 * k + 1], pos[3 * k2 + 2] - pos[3 * k + 2]);
      steps.push(Math.abs(d) / arc);
    }
    const mean = steps.reduce((a, b) => a + b, 0) / n;
    for (const s of steps) expect(Math.abs(s - mean) / mean).toBeLessThan(0.08); // an angle-based mapping is off by ~65% here
    // the distance along the axis is the third coordinate
    expect(Math.abs(w[4 * (40 * n) + 2] - w[2])).toBeCloseTo(120, 1);
  });

  it("ignores a bore inside, and fades out on an end face", () => {
    // an outer tube (normals out) and a bore (normals in) at a quarter its radius, plus an end-face vertex
    const n = 64, pos: number[] = [], nrm: number[] = [];
    for (let j = 0; j <= 10; j++) for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n, x = 12 * j;
      pos.push(x, 20 * Math.cos(a), 20 * Math.sin(a)); nrm.push(0, Math.cos(a), Math.sin(a));
      pos.push(x, 5 * Math.cos(a), 5 * Math.sin(a)); nrm.push(0, -Math.cos(a), -Math.sin(a));
    }
    pos.push(0, 12, 0); nrm.push(-1, 0, 0);
    const w = wrapCoords(Float32Array.from(pos), Float32Array.from(nrm));
    expect(w[w.length - 1]).toBeCloseTo(2 * Math.PI * 20, -0.5);            // the girth is the outside's, not the bore's
    expect(Math.hypot(w[w.length - 4], w[w.length - 3])).toBeLessThan(1e-6); // the end face: no pattern
    expect(Math.hypot(w[0], w[1])).toBeCloseTo(1, 6);                        // the side: all of it
  });

  it("only wrapped patterns ask for it", () => {
    expect(wrapsTexture({ kind: "rubber", texture: "hex", textureWrap: true })).toBe(true);
    expect(wrapsTexture({ kind: "rubber", texture: "hex" })).toBe(false);
    expect(wrapsTexture({ kind: "rubber", texture: "ribs", textureWrap: true })).toBe(false);
    expect(wrapsTexture({ kind: "wood", texture: "knurl", textureWrap: true })).toBe(false);
  });
});
