import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, echoSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { gearOutline, centreDistance } from "../src/core/geometry/gear";
import { sampleSpline } from "../src/core/geometry/spline";
import { extractRegions } from "../src/core/geometry/profile";
import type { Pt } from "../src/core/geometry/spline";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const polar = (p: Pt) => ({ r: Math.hypot(p.x, p.y), a: Math.atan2(p.y, p.x) });

/** Boundary of an outline as a dense polygon (splines sampled). */
function polygon(o: ReturnType<typeof gearOutline>): Pt[] {
  const pts: Pt[] = [o.start];
  let cur = o.start;
  for (const e of o.edges) {
    if (e.kind === "line") pts.push(e.to);
    else if (e.kind === "spline") pts.push(...sampleSpline([cur, ...e.through], 6).slice(1));
    else {
      const a0 = Math.atan2(cur.y, cur.x); let a1 = Math.atan2(e.to.y, e.to.x);
      while (a1 <= a0) a1 += Math.PI * 2;
      for (let k = 1; k <= 8; k++) { const a = a0 + ((a1 - a0) * k) / 8; pts.push({ x: e.r * Math.cos(a), y: e.r * Math.sin(a) }); }
    }
    cur = e.kind === "spline" ? e.through[e.through.length - 1] : e.to;
  }
  return pts;
}

/** Points of the polygon within `tol` of radius r, as angles. */
const anglesAt = (poly: Pt[], r: number, tol: number) => poly.map(polar).filter((p) => Math.abs(p.r - r) < tol).map((p) => p.a);

describe("involute gear generator (pure)", () => {
  it("external gear: closed outline, correct radii, tooth thickness πm/2 at the pitch circle", () => {
    const g = gearOutline({ module: 2, teeth: 20 });
    expect(g.radii).toEqual({ pitch: 20, base: 20 * Math.cos(Math.PI / 9), tip: 22, root: 17.5 });
    const last = g.edges[g.edges.length - 1];
    expect(last.kind).toBe("arc");
    expect((last as { to: Pt }).to).toEqual(g.start);
    // Every point of the boundary lies between the root and tip circles.
    const poly = polygon(g);
    for (const p of poly.map(polar)) { expect(p.r).toBeGreaterThan(17.5 - 1e-6); expect(p.r).toBeLessThan(22 + 1e-6); }
    // Tooth 0 (centred at angle 0): the flanks cross the pitch circle at ±(πm/4)/rp → thickness πm/2.
    const flankIds = g.edges.filter((e) => e.kind === "spline");
    expect(flankIds.length).toBe(20 * 4); // 2 fillets + 2 involutes per tooth
    const involutes = [...g.edges].slice(0, 6).filter((e) => e.kind === "spline") as { through: Pt[] }[];
    const rightFlank = involutes[1].through, leftFlank = involutes[2].through; // right: root→tip; left: tip→root
    const atPitch = (pts: Pt[]) => {
      const sorted = sampleSpline(pts, 40).map(polar).sort((a, b) => a.r - b.r);
      const i = sorted.findIndex((p) => p.r >= 20);
      const a = sorted[i - 1], b = sorted[i];
      return a.a + ((b.a - a.a) * (20 - a.r)) / (b.r - a.r);
    };
    const thickness = 20 * (atPitch(leftFlank) - atPitch(rightFlank));
    expect(thickness).toBeCloseTo((Math.PI * 2) / 2, 2);
  });

  it("external gear: root fillet is the trochoid envelope — it bottoms on the root circle and meets the involute tangentially", () => {
    const g = gearOutline({ module: 2, teeth: 30 });
    const [fillet, flank] = g.edges.filter((e) => e.kind === "spline") as { through: Pt[] }[]; // tooth 0, right side: fillet (root→contact), involute
    const rootPt = g.start; // start = right root point of tooth 0
    expect(polar(rootPt).r).toBeCloseTo(g.radii!.root, 6);
    // contact lies above the base circle (no undercut at 30 teeth) and the involute continues from it
    const contact = polar(fillet.through[fillet.through.length - 1]);
    expect(contact.r).toBeGreaterThan(g.radii!.base);
    expect(polar(flank.through[0]).r).toBeGreaterThan(contact.r);
    // tangency: the direction into the contact along the fillet ≈ the direction out of it along the involute
    const a = fillet.through[fillet.through.length - 2], b = fillet.through[fillet.through.length - 1], c = flank.through[0];
    const d1 = Math.atan2(b.y - a.y, b.x - a.x), d2 = Math.atan2(c.y - b.y, c.x - b.x);
    let diff = Math.abs(d1 - d2); if (diff > Math.PI) diff = 2 * Math.PI - diff;
    expect(diff).toBeLessThan((6 * Math.PI) / 180);
  });

  it("external gear: small tooth counts are undercut (the fillet crosses the involute above the base circle)", () => {
    const g = gearOutline({ module: 2, teeth: 10 });
    const [fillet] = g.edges.filter((e) => e.kind === "spline") as { through: Pt[] }[];
    const contact = polar(fillet.through[fillet.through.length - 1]);
    expect(contact.r).toBeGreaterThan(g.radii!.base); // the involute only survives above the base circle: undercut
    // The undercut waist: the fillet comes closest to the tooth centreline BELOW the base circle, then bends back
    // out to meet the involute — the tooth is narrower there than the involute would make it.
    const pts = fillet.through.map(polar);
    const waist = pts.reduce((a, b) => (b.a > a.a ? b : a));
    expect(waist.r).toBeLessThan(g.radii!.base);
    expect(waist.a).toBeGreaterThan(contact.a);
    // No swallowtail survives: the sampled fillet never doubles back along the curve (consecutive points keep moving outward).
    for (let i = 1; i < pts.length; i++) expect(pts[i].r).toBeGreaterThan(pts[i - 1].r);
    // The undercut flank is narrower than the involute would be at the contact radius — the outline still closes.
    expect((g.edges[g.edges.length - 1] as { to: Pt }).to).toEqual(g.start);
  });

  it("sharp-root option: radial stems from root to base circle on small gears, none on large ones", () => {
    const small = gearOutline({ module: 2, teeth: 20, rootFillet: 0 });
    expect(small.edges.filter((e) => e.kind === "line").length).toBe(40);
    const big = gearOutline({ module: 2, teeth: 60, rootFillet: 0 });
    expect(big.edges.filter((e) => e.kind === "line").length).toBe(0); // root circle outside the base circle
  });

  it("rack: exact basic-rack geometry with tooth thickness πm/2 at the pitch line and tangent root fillets", () => {
    const g = gearOutline({ type: "rack", module: 2, teeth: 6 });
    expect(g.rack!.pitch).toBeCloseTo(Math.PI * 2, 9);
    expect(g.rack!.length).toBeCloseTo(6 * Math.PI * 2, 9);
    const lines = g.edges.filter((e) => e.kind === "line") as { to: Pt }[];
    const tipPts = lines.map((l) => l.to).filter((p) => Math.abs(p.y - 2) < 1e-9);
    const rootPts = lines.map((l) => l.to).filter((p) => Math.abs(p.y + 2.5) < 1e-9);
    expect(tipPts.length).toBe(12); expect(rootPts.length).toBe(12 + 2);
    // Flank straight at 20°: tip half-thickness = πm/4 − ha·m·tan20; root half-thickness = πm/4 + hf·m·tan20.
    const tan = Math.tan(Math.PI / 9);
    const [t1, t0] = tipPts.slice(0, 2);
    expect(Math.abs(t1.x - t0.x) / 2).toBeCloseTo(Math.PI / 2 - 2 * tan, 9);
    // Interpolate the thickness at the pitch line (v=0) between a tip and a root corner of one tooth.
    const c = (lines[2].to.x + lines[5].to.x) / 2; // first tooth's root corners straddle its centre
    const halfRoot = lines[2].to.x - c, halfTip = lines[3].to.x - c;
    const halfPitch = halfRoot + ((halfTip - halfRoot) * 2.5) / 4.5;
    expect(2 * halfPitch).toBeCloseTo(Math.PI, 9);
    expect(g.edges.filter((e) => e.kind === "line" && e.filletAtEnd).length).toBe(12);
    const spaced = gearOutline({ type: "rack", module: 2, teeth: 6, pressureAngle: 20 }).edges.filter((e) => e.kind === "line" && e.filletAtEnd);
    expect(spaced.every((e) => (e as { filletAtEnd: number }).filletAtEnd === 0.76)).toBe(true);
  });

  it("internal gear: teeth widen toward the root (outside) and a rim circle closes the annulus", () => {
    const g = gearOutline({ type: "internal", module: 2, teeth: 40 });
    expect(g.circles.length).toBe(1);
    expect(g.circles[0].r).toBeCloseTo(40 + 2.5 + 6, 9);
    const poly = polygon(g);
    const tipAngles = anglesAt(poly, g.radii!.tip, 1e-6);
    expect(tipAngles.length).toBeGreaterThan(0);
    const rootW = anglesAt(poly, g.radii!.root, 1e-6).filter((a) => Math.abs(a) < Math.PI / 40).sort((a, b) => a - b);
    const tipW = tipAngles.filter((a) => Math.abs(a) < Math.PI / 40).sort((a, b) => a - b);
    expect(rootW[rootW.length - 1] - rootW[0]).toBeGreaterThan(tipW[tipW.length - 1] - tipW[0]);
  });

  it("meshing helpers: centre distance", () => {
    expect(centreDistance(2, 20, 12)).toBe(32);
  });
});

describe("gear → sketch → solid", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("sketch.addGear makes a single region (with a bore hole) that extrudes to a spur gear", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const r = await s.dispatch("sketch.addGear", { sketch: sid, module: 2, teeth: 20 });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/pitch r=20/);
    await s.dispatch("sketch.addCircle", { sketch: sid, center: { ref: r.createdIds[0] }, radius: 5 });
    const regions = extractRegions(s.doc.sketches[sid]);
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1);
    await s.dispatch("feature.extrude", { sketch: sid, distance: "8" });
    const solids = Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope));
    const body = solids.find((x) => x.mesh)!;
    expect(body.error).toBeUndefined();
    expect(body.bounds!.max.x).toBeCloseTo(22, 2);
    expect(body.bounds!.min.y).toBeCloseTo(-22, 2);
    // Volume between the root and tip discs (minus the bore).
    const hole = Math.PI * 25 * 8;
    expect(body.volume!).toBeGreaterThan(Math.PI * 17.5 ** 2 * 8 - hole);
    expect(body.volume!).toBeLessThan(Math.PI * 22 ** 2 * 8 - hole);
  });

  it("a rack and an internal gear both extrude cleanly", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const rack = await s.dispatch("sketch.addGear", { sketch: sid, type: "rack", module: 2, teeth: 8, center: { x: 0, y: -60 } });
    expect(rack.ok).toBe(true);
    const ring = await s.dispatch("sketch.addGear", { sketch: sid, type: "internal", module: 2, teeth: 36, center: { x: 0, y: 60 } });
    expect(ring.ok).toBe(true);
    await s.dispatch("feature.extrude", { sketch: sid, distance: "6" });
    const solids = Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope));
    const body = solids.find((x) => x.mesh)!;
    expect(body.error).toBeUndefined();
    const arcs = Object.values(s.doc.sketches[sid].entities).filter((e) => e.kind === "arc").length;
    expect(arcs).toBeGreaterThanOrEqual(16 + 72); // rack root fillets + ring tip/root arcs
  });

  it("gear operations replay deterministically (undo/redo keeps ids stable)", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const r = await s.dispatch("sketch.addGear", { sketch: sid, module: 1, teeth: 12 });
    const before = Object.keys(s.doc.sketches[sid].entities).length;
    s.undo();
    expect(Object.keys(s.doc.sketches[sid].entities).length).toBeLessThan(before);
    s.redo();
    expect(Object.keys(s.doc.sketches[sid].entities).length).toBe(before);
    expect(s.doc.sketches[sid].entities[r.createdIds[1]]).toBeDefined();
  });
});
