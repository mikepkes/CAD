import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, echoSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import { pickFace } from "../src/core/geometry/pick";
import type { CadSession } from "../src/core/command/session";

// The modeling workflows added after the game-asset study: extrude direction /
// through-all, revolve, fillet/chamfer, shell, body patterns, selective mirror,
// diagnostics (warnings, bounds, volume) and the sketch conveniences.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

function evalAll(s: CadSession): Record<string, SolidEval> {
  return evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
}
const bodies = (s: CadSession) => Object.values(evalAll(s)).filter((b) => b.mesh);
const size = (b: SolidEval, axis: "x" | "y" | "z") => b.bounds!.max[axis] - b.bounds!.min[axis];

async function block(s: CadSession, w: number, h: number, extra: Record<string, unknown> = {}) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: -w / 2, y: -w / 2 }, opposite: { x: w / 2, y: w / 2 } });
  const f = await s.dispatch("feature.extrude", { sketch: sid, distance: String(h), ...extra });
  return { sid, featureId: f.createdIds[0], ok: f.ok, error: f.error };
}

describe("modeling workflows (OCC)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("reports bounds and volume per body", async () => {
    const s = realSession();
    await block(s, 40, 20);
    const [b] = bodies(s);
    expect(size(b, "x")).toBeCloseTo(40, 3);
    expect(size(b, "z")).toBeCloseTo(20, 3);
    expect(b.volume).toBeCloseTo(40 * 40 * 20, 1);
  });

  it("extrude direction reverse goes against the normal", async () => {
    const s = realSession();
    await block(s, 20, 10, { direction: "reverse" });
    const [b] = bodies(s);
    expect(b.bounds!.max.z).toBeCloseTo(0, 6);
    expect(b.bounds!.min.z).toBeCloseTo(-10, 6);
  });

  it("extent throughAll cuts all the way through regardless of distance", async () => {
    const s = realSession();
    await block(s, 40, 30);
    const top = (await s.dispatch("sketch.create", { plane: "XY", offset: 30 })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: top, center: { x: 0, y: 0 }, radius: 5 });
    await s.dispatch("feature.extrude", { sketch: top, distance: "1", operation: "cut", direction: "reverse", extent: "throughAll" });
    const [b] = bodies(s);
    expect(b.volume).toBeCloseTo(40 * 40 * 30 - Math.PI * 25 * 30, 0); // full-depth hole
    expect(size(b, "z")).toBeCloseTo(30, 6);
  });

  it("warns when a cut misses the body instead of failing silently", async () => {
    const s = realSession();
    await block(s, 40, 30);
    const far = (await s.dispatch("sketch.create", { plane: "XY", offset: 100 })).createdIds[0];
    await s.dispatch("sketch.addCircle", { sketch: far, center: { x: 0, y: 0 }, radius: 5 });
    const cut = await s.dispatch("feature.extrude", { sketch: far, distance: "5", operation: "cut" });
    const row = evalAll(s)[cut.createdIds[0]];
    expect(row.warning).toMatch(/changed nothing/);
  });

  it("fillet rounds every edge; a selector limits it to the vertical ones", async () => {
    const all = realSession();
    await block(all, 40, 20);
    const f = await all.dispatch("feature.fillet", { radius: "3" });
    const r = evalAll(all);
    expect(r[f.createdIds[0]].error).toBeUndefined();
    const [b] = Object.values(r).filter((x) => x.mesh);
    expect(size(b, "x")).toBeCloseTo(40, 3);
    expect(b.volume!).toBeLessThan(40 * 40 * 20);
    expect(b.mesh!.triangleCount).toBeGreaterThan(12);

    const vertical = realSession();
    await block(vertical, 40, 20);
    await vertical.dispatch("feature.fillet", { radius: "5", edges: { parallelTo: "Z" } });
    const [v] = bodies(vertical);
    // Only the 4 vertical corners removed: volume = full − 4 × (r² − πr²/4) × h
    expect(v.volume).toBeCloseTo(40 * 40 * 20 - 4 * (25 - Math.PI * 25 / 4) * 20, 0);
  });

  it("chamfer bevels the top outline selected by inPlane", async () => {
    const s = realSession();
    await block(s, 40, 20);
    const c = await s.dispatch("feature.chamfer", { distance: "2", edges: { inPlane: { plane: "XY", offset: 20 } } });
    const r = evalAll(s);
    expect(r[c.createdIds[0]].error).toBeUndefined();
    const [b] = Object.values(r).filter((x) => x.mesh);
    // Four top edges bevelled 2×2: removes 4 × (½·2·2) × 40 minus the double-counted corners ≈ 320 − small
    expect(b.volume!).toBeLessThan(40 * 40 * 20 - 300);
    expect(b.volume!).toBeGreaterThan(40 * 40 * 20 - 330);
  });

  it("shell hollows the body with the top face open", async () => {
    const s = realSession();
    await block(s, 40, 30);
    const sh = await s.dispatch("feature.shell", { thickness: "2", openFaces: { inPlane: { plane: "XY", offset: 30 } } });
    const r = evalAll(s);
    expect(r[sh.createdIds[0]].error).toBeUndefined();
    const [b] = Object.values(r).filter((x) => x.mesh);
    expect(b.volume).toBeCloseTo(40 * 40 * 30 - 36 * 36 * 28, 0); // open-top box, 2mm walls + floor
  });

  it("revolve turns a half profile into a solid of revolution", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    // profile 0..10 in u (radius), 0..30 in v (height); revolve about the v axis → cylinder r10 h30
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 10, y: 30 } });
    const f = await s.dispatch("feature.revolve", { sketch: sid, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } });
    const r = evalAll(s);
    expect(r[f.createdIds[0]].error).toBeUndefined();
    const [b] = Object.values(r).filter((x) => x.mesh);
    expect(size(b, "x")).toBeCloseTo(20, 2);
    expect(size(b, "y")).toBeCloseTo(20, 2);
    expect(size(b, "z")).toBeCloseTo(30, 2);
    expect(b.volume).toBeCloseTo(Math.PI * 100 * 30, -1);
  });

  it("linear and circular body patterns fuse copies into one body", async () => {
    const lin = realSession();
    await block(lin, 10, 10);
    await lin.dispatch("feature.pattern", { mode: "linear", count: 4, step: { x: 15, y: 0, z: 0 } });
    const lb = bodies(lin);
    expect(lb.length).toBe(1);
    expect(size(lb[0], "x")).toBeCloseTo(10 + 3 * 15, 3);
    expect(lb[0].volume).toBeCloseTo(4 * 1000, 1);

    const circ = realSession();
    const sid = (await circ.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await circ.dispatch("sketch.addCircle", { sketch: sid, center: { x: 20, y: 0 }, radius: 3 });
    await circ.dispatch("feature.extrude", { sketch: sid, distance: "5" });
    await circ.dispatch("feature.pattern", { mode: "circular", count: 6, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } } });
    const cb = bodies(circ);
    expect(cb.length).toBe(1);
    expect(size(cb[0], "x")).toBeCloseTo(46, 2);
    expect(cb[0].volume).toBeCloseTo(6 * Math.PI * 9 * 5, 0);
  });

  it("mirror bodies:last reflects only the most recent body", async () => {
    const s = realSession();
    await block(s, 10, 10);                                        // body A at the origin
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 20, y: -5 }, opposite: { x: 30, y: 5 } });
    await s.dispatch("feature.extrude", { sketch: sid, distance: "10" }); // body B at x=20..30
    await s.dispatch("feature.mirror", { plane: "YZ", bodies: "last" });
    const b = bodies(s);
    expect(b.length).toBe(2);
    const a = b.find((x) => size(x, "x") < 15)!, m = b.find((x) => size(x, "x") > 15)!;
    expect(a.volume).toBeCloseTo(1000, 1);                         // A untouched
    expect(m.bounds!.min.x).toBeCloseTo(-30, 6);                   // B mirrored to -30..30
    expect(m.volume).toBeCloseTo(2000, 1);
  });

  it("face pick from meshes finds the top face and its outward normal", async () => {
    const s = realSession();
    await block(s, 40, 20);
    const meshes = bodies(s).map((b) => ({ featureId: b.featureId, mesh: b.mesh! }));
    const hit = pickFace(meshes, { x: 3, y: -4, z: 20.5 })!;
    expect(hit.normal.z).toBeCloseTo(1, 6);
    expect(hit.point.z).toBeCloseTo(20, 6);
    expect(hit.origin).toEqual({ x: 0, y: 0, z: 20 });
    const side = pickFace(meshes, { x: 21, y: 0, z: 10 })!;
    expect(side.normal.x).toBeCloseTo(1, 6);
    expect(side.distance).toBeCloseTo(1, 6);
  });
});

describe("sketch conveniences (pure)", () => {
  it("rectangle returns its line ids and can round its corners", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const plain = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 10 } });
    expect(plain.createdIds.slice(4).every((id) => id.startsWith("ln"))).toBe(true);
    const rounded = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 30, y: 0 }, opposite: { x: 50, y: 10 }, cornerRadius: 2 });
    expect(rounded.ok).toBe(true);
    const arcs = Object.values(s.doc.sketches[sid].entities).filter((e) => e.kind === "arc");
    expect(arcs.length).toBe(4);
  });

  it("polyline, bar and ring build closed profiles in one call", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const pl = await s.dispatch("sketch.addPolyline", { sketch: sid, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 30 }] });
    expect(pl.createdIds.filter((id) => id.startsWith("ln")).length).toBe(4);
    const bar = await s.dispatch("sketch.addBar", { sketch: sid, p1: { x: 0, y: 50 }, p2: { x: 30, y: 90 }, width: 4 });
    expect(bar.createdIds.length).toBe(8);
    const ring = await s.dispatch("sketch.addRing", { sketch: sid, center: { x: 100, y: 100 }, outerRadius: 10, innerRadius: 8 });
    const [outer, inner, c] = ring.createdIds;
    const ents = s.doc.sketches[sid].entities as Record<string, { center?: string }>;
    expect(ents[outer].center).toBe(c);
    expect(ents[inner].center).toBe(c);
  });

  it("filletCorners rounds every two-line corner; fillet accepts a corner point", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const r = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 30, y: 20 } });
    const one = await s.dispatch("sketch.fillet", { sketch: sid, point: r.createdIds[0], radius: 3 });
    expect(one.ok).toBe(true);
    const rest = await s.dispatch("sketch.filletCorners", { sketch: sid, size: 3 });
    expect(rest.ok).toBe(true);
    expect(Object.values(s.doc.sketches[sid].entities).filter((e) => e.kind === "arc").length).toBe(4);
  });

  it("offsetLoop insets a polygon by a distance", async () => {
    const s = echoSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    const r = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
    const inset = await s.dispatch("sketch.offsetLoop", { sketch: sid, lines: r.createdIds.slice(4), distance: -5 });
    expect(inset.ok).toBe(true);
    const pts = inset.createdIds.filter((id) => id.startsWith("pt")).map((id) => s.doc.sketches[sid].entities[id] as { x: number; y: number });
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(5, 6); expect(Math.max(...xs)).toBeCloseTo(35, 6);
    expect(Math.min(...ys)).toBeCloseTo(5, 6); expect(Math.max(...ys)).toBeCloseTo(15, 6);
  });
});
