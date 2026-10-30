import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, bodyTopology } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { pickFace } from "../src/core/geometry/pick";
import type { CadSession } from "../src/core/command/session";

// Topological naming: faces are named where they're made and keep their names
// through booleans, blends, shells and copies; a sketch pinned to a face name
// follows that face, and edges can be picked by the faces they separate.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const topo = (s: CadSession, bodyId?: string) => bodyTopology(s.doc, scopeOf(s), { bodyId });
const faceNames = (s: CadSession, bodyId?: string) => topo(s, bodyId)[0].faces.map((f) => f.name).sort();

async function rectExtrude(s: CadSession, x0: number, y0: number, x1: number, y1: number, distance: string) {
  const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  const r = await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: x0, y: y0 }, opposite: { x: x1, y: y1 } });
  const f = await s.dispatch("feature.extrude", { sketch: sid, distance });
  return { sid, fid: f.createdIds[0], opId: f.opId!, lines: Object.values(s.doc.sketches[sid].entities).filter((e) => e.kind === "line").map((e) => e.id), rect: r };
}

describe("topological naming", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("names an extrusion's caps start/end and each side by the sketch line that swept it", async () => {
    const s = realSession();
    const { fid, lines } = await rectExtrude(s, 0, 0, 20, 10, "5");
    expect(faceNames(s)).toEqual([`${fid}:end`, `${fid}:start`, ...lines.map((l) => `${fid}:side:${l}`)].sort());
    const end = topo(s)[0].faces.find((f) => f.name === `${fid}:end`)!;
    expect(end.center.z).toBeCloseTo(5, 9);
  });

  it("names primitive faces by axis and surface type", async () => {
    const s = realSession();
    const box = (await s.dispatch("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 })).createdIds[0];
    expect(faceNames(s)).toEqual(["+X", "+Y", "+Z", "-X", "-Y", "-Z"].map((a) => `${box}:${a}`).sort());
    const c = realSession();
    const cyl = (await c.dispatch("feature.primitive", { shape: "cylinder", radius: 3, height: 8 })).createdIds[0];
    expect(faceNames(c)).toEqual([`${cyl}:+Z`, `${cyl}:-Z`, `${cyl}:cylinder`].sort());
  });

  it("carries names through a cut: the box keeps its faces, the hole adds bore faces", async () => {
    const s = realSession();
    const box = (await s.dispatch("feature.primitive", { shape: "box", x: 20, y: 20, z: 20 })).createdIds[0];
    const hole = (await s.dispatch("feature.hole", { at: [{ x: 0, y: 0, z: 10 }], diameter: "6", throughAll: true, counterbore: { diameter: "10", depth: "3" } })).createdIds[0];
    const names = faceNames(s);
    for (const a of ["+X", "+Y", "+Z", "-X", "-Y", "-Z"]) expect(names).toContain(`${box}:${a}`);
    expect(names).toContain(`${hole}:bore`);
    expect(names).toContain(`${hole}:cbore`);
    expect(names).toContain(`${hole}:cbore-floor`);
    expect(names.length).toBe(9);
  });

  it("names blend faces by the faces around them, and edges by the faces they separate", async () => {
    const s = realSession();
    const box = (await s.dispatch("feature.primitive", { shape: "box", x: 20, y: 20, z: 20 })).createdIds[0];
    const edge = `${box}:+X|${box}:+Z`;
    expect(topo(s)[0].edges.map((e) => e.name)).toContain(edge);
    // fillet just that one edge, by name: removes r²(1 − π/4) × 20
    const fil = (await s.dispatch("feature.fillet", { radius: "3", edges: { names: [`${box}:+Z|${box}:+X`] } })).createdIds[0];
    const t = topo(s)[0];
    expect(t.volume).toBeCloseTo(8000 - 9 * (1 - Math.PI / 4) * 20, 6);
    const blends = t.faces.filter((f) => f.name.startsWith(`${fil}:blend`));
    expect(blends.length).toBe(1);
    expect(blends[0].name).toBe(`${fil}:blend(${[`${box}:+X`, `${box}:+Y`, `${box}:+Z`, `${box}:-Y`].sort().join(",")})`);
  });

  it("names a shell's inner walls after the outer faces they offset", async () => {
    const s = realSession();
    const box = (await s.dispatch("feature.primitive", { shape: "box", x: 40, y: 40, z: 30, at: { x: 0, y: 0, z: 15 } })).createdIds[0];
    const sh = (await s.dispatch("feature.shell", { thickness: "2", openFaces: { inPlane: { plane: "XY", offset: 30 } } })).createdIds[0];
    const names = faceNames(s);
    for (const a of ["+X", "-X", "+Y", "-Y", "-Z"]) expect(names).toContain(`${sh}:inner(${box}:${a})`);
    const at = (n: string) => topo(s)[0].faces.find((f) => f.name === n)!.center;
    expect(at(`${sh}:inner(${box}:+X)`).x).toBeCloseTo(18, 9); // the wall 2 inside +X, not across the cavity
    expect(at(`${sh}:inner(${box}:-Z)`).z).toBeCloseTo(2, 9);
  });

  it("tags pattern copies so every instance's faces stay addressable", async () => {
    const s = realSession();
    const box = (await s.dispatch("feature.primitive", { shape: "box", x: 10, y: 10, z: 10 })).createdIds[0];
    const pat = (await s.dispatch("feature.pattern", { mode: "linear", count: 3, step: { x: 20, y: 0, z: 0 } })).createdIds[0];
    const names = faceNames(s);
    expect(names).toContain(`${box}:+Z`);
    expect(names).toContain(`${box}:+Z@${pat}.1`);
    expect(names).toContain(`${box}:+Z@${pat}.2`);
    expect(names.length).toBe(18);
  });

  it("a sketch pinned to a face name follows that face where the geometric match would jump bodies", async () => {
    const build = async (pin: boolean) => {
      const s = realSession();
      const a = await rectExtrude(s, -10, -10, 10, 10, "10"); // body A, top at z=10
      await rectExtrude(s, 15, -5, 25, 5, "10");             // body B beside it, also top at z=10
      const top = { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 } };
      const sk = (await s.dispatch("sketch.create", { planeDef: top, faceRef: { normal: top.normal, point: top.origin, ...(pin ? { name: `${a.fid}:end` } : {}) } })).createdIds[0];
      await s.dispatch("sketch.addCircle", { sketch: sk, center: { x: 0, y: 0 }, radius: 3 });
      await s.dispatch("feature.extrude", { sketch: sk, distance: "5", operation: "join", body: a.fid });
      // raise A to 40: its top is now 30 from the pick point, B's (unchanged) only 20
      await s.editOperation(a.opId, { sketch: a.sid, distance: "40" });
      evaluateFeatures(s.doc, scopeOf(s));
      return s.doc.sketches[sk].plane!.origin.z;
    };
    expect(await build(true)).toBeCloseTo(40, 9);  // follows A's top
    expect(await build(false)).toBeCloseTo(10, 9); // the geometric match lands on B
  });

  it("display meshes carry face names, so a pick knows which face it hit", async () => {
    const s = realSession();
    const { fid } = await rectExtrude(s, 0, 0, 20, 10, "5");
    const out = evaluateFeatures(s.doc, scopeOf(s));
    const mesh = out[fid].mesh!;
    expect(mesh.faceNames?.length).toBe(6);
    expect(mesh.faceRanges?.length).toBe(12);
    const hit = pickFace([{ featureId: fid, mesh }], { x: 10, y: 5, z: 5.2 });
    expect(hit?.faceName).toBe(`${fid}:end`);
  });
});
