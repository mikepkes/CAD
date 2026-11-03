// feature.voronoi: a Voronoi pattern of openings wrapped round a hollow body. The layout (pure) must tile its
// band with cells that don't overlap, wrap round with no seam, and leave at least the web between openings;
// the built body must have one separate opening per cell, each a web clear of its neighbours and of the band's
// ends, on a twisted body as well as a round one.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, itFull } from "./helpers";
import {
  periodicCells, voronoiStrip, voronoiWall, polygonArea, polygonCentroid, clipHalfPlane, RadialProbe, outlinePoints, insetConvex, P2,
} from "../src/core/geometry/voronoi";
import { initKernel, intersectShapes, distanceBetween, boundsOfShape, volumeOfShape } from "../src/core/occ/kernel";
import type { SolidMesh } from "../src/core/occ/kernel";
import { evaluateBodies, evaluateFeatures, voronoiLayout, voronoiCutter } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { VoronoiFeature } from "../src/core/document";

/** Area two convex polygons share. */
function overlap(a: P2[], b: P2[]): number {
  let c = a;
  for (let i = 0; i < b.length && c.length >= 3; i++) {
    const p = b[i], q = b[(i + 1) % b.length];
    const n = { x: -(q.y - p.y), y: q.x - p.x }; // inward for CCW
    c = clipHalfPlane(c, n, n.x * p.x + n.y * p.y);
  }
  return c.length >= 3 ? Math.abs(polygonArea(c)) : 0;
}
const shift = (poly: P2[], dx: number) => poly.map((p) => ({ x: p.x + dx, y: p.y }));

/** A twisted hexagonal tube (no caps: the band never reaches them), `turn` radians over its height, with a
 *  `wall`-thick wall, triangulated, in the axis frame. */
function twistedHexTube(R: number, wall: number, height: number, turn: number): { p: Float64Array; tri: Uint32Array } {
  const rows = 40, pts: number[] = [], tri: number[] = [];
  const ring = (r: number, z: number, a0: number) => { const base = pts.length / 3; for (let k = 0; k < 6; k++) { const a = a0 + (k * Math.PI) / 3; pts.push(r * Math.cos(a), r * Math.sin(a), z); } return base; };
  const rIn = R - wall / Math.cos(Math.PI / 6);
  let prevO = -1, prevI = -1;
  for (let j = 0; j <= rows; j++) {
    const z = (height * j) / rows, a0 = (turn * j) / rows;
    const o = ring(R, z, a0), i = ring(rIn, z, a0);
    if (j) for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      tri.push(prevO + k, prevO + k2, o + k2, prevO + k, o + k2, o + k);
      tri.push(prevI + k, i + k2, prevI + k2, prevI + k, i + k, i + k2);
    }
    prevO = o; prevI = i;
  }
  return { p: new Float64Array(pts), tri: new Uint32Array(tri) };
}

describe("voronoi layout", () => {
  const period = 250, z0 = 5, z1 = 135;
  const { seeds, cells } = voronoiStrip({ count: 40, seed: 3, period, z0, z1, relax: 6 });

  it("tiles the band: the cells cover it exactly, and no two overlap (round the seam either)", () => {
    expect(cells.every((c) => c.length >= 3)).toBe(true);
    const total = cells.reduce((s, c) => s + polygonArea(c), 0);
    expect(total).toBeCloseTo(period * (z1 - z0), 6);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      for (const k of [-1, 0, 1]) expect(overlap(cells[i], shift(cells[j], k * period))).toBeLessThan(1e-6);
    }
  });

  it("has no seam: turning every seed turns the whole pattern with it", () => {
    for (const dx of [37.3, period / 2, 211]) {
      const turned = periodicCells(seeds.map((s) => ({ x: (s.x + dx) % period, y: s.y })), period, z0, z1);
      turned.forEach((c, i) => {
        expect(polygonArea(c)).toBeCloseTo(polygonArea(cells[i]), 6);
        const a = polygonCentroid(c), b = polygonCentroid(cells[i]);
        const d = ((a.x - b.x - dx) % period + 1.5 * period) % period - period / 2;
        expect(Math.abs(d)).toBeLessThan(1e-6);
        expect(a.y).toBeCloseTo(b.y, 6);
      });
    }
    // and a cell does straddle the turn's start (x = 0): it's one cell, not two halves
    expect(cells.some((c) => Math.min(...c.map((p) => p.x)) < 0 || Math.max(...c.map((p) => p.x)) > period)).toBe(true);
  });

  it("is repeatable from its seed, and another seed is another pattern", () => {
    const again = voronoiStrip({ count: 40, seed: 3, period, z0, z1, relax: 6 });
    expect(again.seeds).toEqual(seeds);
    const other = voronoiStrip({ count: 40, seed: 4, period, z0, z1, relax: 6 });
    expect(other.seeds).not.toEqual(seeds);
  });

  it("relaxing evens the cells out", () => {
    const spread = (cs: P2[][]) => { const a = cs.map((c) => polygonArea(c)); const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) / m; };
    const raw = voronoiStrip({ count: 40, seed: 3, period, z0, z1, relax: 0 });
    expect(spread(cells)).toBeLessThan(spread(raw.cells) / 2);
  });

  it("insets each opening a web from its cell, on a twisted wall, measured on the wall's inner face", () => {
    const height = 160, turn = Math.PI / 2, web = 3;
    const tube = twistedHexTube(45, 1.6, height, turn);
    const probe = new RadialProbe(tube.p, tube.tri);
    const w = voronoiWall({ probe, count: 48, seed: 7, relax: 8, web, round: 1.5, from: 14, to: 148, twist: turn });
    expect(w.openings.length + w.skipped).toBe(48);
    expect(w.openings.length).toBeGreaterThan(40);
    // each opening's real outline (the cutter's), wrapped onto the inner face of the wall
    const onWall = w.openings.map((o) => o.polygon.map((q) => { const r = probe.hits(q.x, q.y)[0]; return { x: r * Math.cos(q.x), y: r * Math.sin(q.x), z: q.y }; }));
    let least = Infinity;
    for (let i = 0; i < onWall.length; i++) for (let j = i + 1; j < onWall.length; j++) {
      for (const a of onWall[i]) for (const b of onWall[j]) least = Math.min(least, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
    expect(least).toBeGreaterThanOrEqual(web);
    expect(least).toBeLessThan(web * 1.25); // and not much more: the web is what was asked for
    // a web from the band's ends too
    for (const o of w.openings) for (const q of o.polygon) { expect(q.y).toBeGreaterThanOrEqual(14 + web - 1e-9); expect(q.y).toBeLessThanOrEqual(148 - web + 1e-9); }
    // the cutters reach from inside the wall to outside it
    for (const o of w.openings) for (const q of o.polygon) { const h = probe.hits(q.x, q.y), c = Math.cos(q.x - o.theta); expect(o.rIn / c).toBeLessThan(h[0]); expect(o.rOut / c).toBeGreaterThan(h[h.length - 1]); }
  });

  it("leaves a cell too small for an opening solid, and says so", () => {
    const tube = twistedHexTube(45, 1.6, 160, 0);
    const probe = new RadialProbe(tube.p, tube.tri);
    const w = voronoiWall({ probe, count: 200, seed: 1, relax: 0, web: 8, round: 0, from: 14, to: 148, twist: 0 });
    expect(w.skipped).toBeGreaterThan(0);
    for (const o of w.openings) expect(insetConvex(o.polygon.map((p) => ({ x: p.x * o.rWall, y: p.y })), 0).length).toBeGreaterThan(2);
  });

  it("needs a hollow body round the axis", () => {
    // a solid hexagonal prism: one crossing out from the axis, not two
    const tube = twistedHexTube(45, 1.6, 160, 0);
    const outerOnly = new Uint32Array([...tube.tri].filter((_, i) => Math.floor(i / 6) % 2 === 0));
    expect(() => voronoiWall({ probe: new RadialProbe(tube.p, outerOnly), count: 20, seed: 1, relax: 2, web: 3, round: 0, from: 14, to: 148, twist: 0 })).toThrow(/hollow/);
  });

  it("samples arcs and lines along an outline", () => {
    const pts = outlinePoints({ start: { x: 1, y: 0 }, segments: [{ kind: "arc", to: { x: -1, y: 0 }, via: { x: 0, y: 1 } }, { kind: "line", to: { x: 1, y: 0 } }] }, 8, 0.5);
    for (const p of pts.slice(0, 9)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
    expect(pts.slice(0, 9).every((p) => p.y >= -1e-9)).toBe(true);
    expect(pts.length).toBe(9 + 4);
  });
});

// ---- on the real twisted vase, through the kernel ----

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

/** Genus of a closed triangulated surface (vertices welded at 1 µm): one per tunnel through the wall. */
function genus(mesh: SolidMesh): number {
  const ids = new Map<string, number>();
  const vid = (i: number) => {
    const k = [0, 1, 2].map((a) => Math.round(mesh.positions[3 * i + a] * 1000)).join(",");
    let v = ids.get(k);
    if (v == null) ids.set(k, (v = ids.size));
    return v;
  };
  const edges = new Set<string>();
  let faces = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vid(mesh.indices[t + k]));
    if (a === b || b === c || a === c) continue;
    faces++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.add(p < q ? `${p}-${q}` : `${q}-${p}`);
  }
  return (2 - (ids.size - edges.size + faces)) / 2;
}

describe("feature.voronoi on the twisted vase", () => {
  // a minute or more of booleans in one synchronous call: the extended run, like the other vase builds
  itFull("cuts one separate opening per cell, each a web clear of its neighbours and of the band's ends", async () => {
    const cache = JSON.parse(readFileSync(fileURLToPath(new URL("../video/mock/agent-vase.json", import.meta.url)), "utf8"));
    const s = realSession();
    // the vase: the first prompt's turns (parameters, sections, loft, shell)
    for (const turn of cache.turns.slice(0, 6)) for (const b of turn.content) {
      if (b.type !== "tool_use") continue;
      const r = await s.dispatch(b.name.replace(/__/g, "."), b.input);
      expect(r.ok, `${b.id}: ${r.error}`).toBe(true);
    }
    const web = 3, from = 14, to = 148;
    const r = await s.dispatch("feature.voronoi", { cells: 20, seed: 7, web: String(web), round: "1.5", from: String(from), to: String(to), twist: "90" });
    expect(r.ok, r.error).toBe(true);
    const scope = resolveParameters(s.doc.parameters).scope;
    const rows = evaluateFeatures(s.doc, scope);
    const f = Object.values(s.doc.features).find((x) => x.kind === "voronoi") as VoronoiFeature;
    expect(rows[f.id].error).toBeUndefined();
    const n = f.openingsValue!;
    expect(n).toBeGreaterThan(15);
    const body = Object.values(rows).find((x) => x.mesh)!;
    // an open-top hollow vase is a sphere (genus 0); each separate opening adds one tunnel. Two openings that
    // ran into each other (across the seam or anywhere) would make one tunnel, an opening split in two, two.
    expect(genus(body.mesh!)).toBe(n);

    // measure the plugs each opening takes out of the uncut vase
    delete s.doc.features[f.id];
    const { bodies } = evaluateBodies(s.doc, scope);
    const vase = bodies[0].shape;
    const vb = boundsOfShape(vase);
    const { wall, frame } = voronoiLayout(scope, { ...f }, vase);
    const plugs = wall.openings.map((o) => { const c = voronoiCutter(o, frame); try { return intersectShapes(vase, c); } finally { c.delete(); } });
    try {
      expect(plugs.every((p) => volumeOfShape(p) > 0)).toBe(true);
      // neighbours (cells that share an edge, round the seam included) are at least a web apart
      const P = wall.strip.cells, period = 2 * Math.PI * wall.radius;
      const touchAt = (a: P2[], b: P2[], k: number) => a.some((p) => b.some((q) => Math.hypot(p.x - q.x - k * period, p.y - q.y) < 1e-6));
      let pairs = 0, seam = 0;
      for (let i = 0; i < plugs.length; i++) for (let j = i + 1; j < plugs.length; j++) {
        const a = P[wall.cellOf[i]], b = P[wall.cellOf[j]];
        if (![-1, 0, 1].some((k) => touchAt(a, b, k))) continue;
        pairs++;
        if (!touchAt(a, b, 0)) seam++;
        expect(distanceBetween(plugs[i], plugs[j]), `openings ${i} and ${j}`).toBeGreaterThanOrEqual(web * (1 - 1e-3));
      }
      expect(pairs).toBeGreaterThan(plugs.length); // a Voronoi tiling: about three neighbours each
      expect(seam).toBeGreaterThan(0); // some of them across the seam
      // and a web from the band's ends: no opening comes nearer than `web` to `from` or `to`
      for (const p of plugs) {
        const b = boundsOfShape(p);
        expect(b.min.z).toBeGreaterThanOrEqual(from + web - 1e-3);
        expect(b.max.z).toBeLessThanOrEqual(to + 1e-3 - web);
      }
      expect(vb.max.z).toBeGreaterThan(to); // the rim stays whole above the band
    } finally { for (const p of plugs) p.delete(); vase.delete(); }
  }, 300000);
});
