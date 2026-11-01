import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";
import { STAND, box, sideSketch, backProfile, lipProfile, across, lipOutline } from "../src/demo/stand";
import { featureRows, pinAnchor } from "../src/model/concepts/featureCatalog";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

const bodies = (s: CadSession) => Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope)).filter((b) => b.mesh);

async function build(parametric: boolean) {
  const s = realSession();
  const h = { dispatch: (t: string, p: Record<string, unknown>) => s.dispatch(t, p), doc: () => s.doc };
  if (parametric) await s.dispatch("parameter.add", { name: "phone", expression: String(STAND.phone) });
  await box(h);
  const back = await sideSketch(h);
  await backProfile(h, back);
  await across(h, back);
  const lip = await sideSketch(h);
  const corners = await lipProfile(h, lip, STAND, parametric ? "phone" : undefined);
  await across(h, lip);
  return { s, lip, corners };
}

describe("the tutorial's phone stand", () => {
  it("builds as one body: base, back plate and lip", async () => {
    const { s } = await build(false);
    const b = bodies(s);
    expect(b.length).toBe(1);
    expect(b[0].bounds!.max.z).toBeCloseTo(STAND.base + STAND.height, 3);
    expect(b[0].bounds!.min.x).toBeCloseTo(-STAND.width / 2, 3);
    expect(b[0].bounds!.max.x).toBeCloseTo(STAND.width / 2, 3);
  });

  it("moves the lip with the phone parameter", async () => {
    const { s, lip, corners } = await build(true);
    const back = () => s.doc.sketches[lip].entities[corners[1]] as unknown as { x: number; y: number };
    expect(back().x).toBeCloseTo(lipOutline().at(1)!.y, 6); // the plate front, less phone + 2
    const op = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(op.opId, { ...op.params, expression: "14" });
    expect(back().x).toBeCloseTo(STAND.plateFront - 16, 6);
    expect(back().y).toBeCloseTo(STAND.base, 6);
    expect(bodies(s).length).toBe(1);
  });

  it("pins each feature on its own geometry, not in the air above the joined body", async () => {
    const { s } = await build(false);
    const solids = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, solids);
    const [base, back, lip] = rows.map((r) => pinAnchor(r)!);
    expect(base.z).toBeLessThanOrEqual(STAND.base + 1e-6); // the base's own face, not the top of the plate
    expect(back.z).toBeGreaterThan(STAND.base);
    const l = lipOutline();
    expect(lip.y).toBeGreaterThanOrEqual(l[0].y - 1e-6);
    expect(lip.y).toBeLessThanOrEqual(l[1].y + 1e-6);
    expect(lip.z).toBeLessThanOrEqual(STAND.base + STAND.lipH + 1e-6);
  });

  it("keeps a box's pin on its top while it's resized, even when a side becomes the largest face", async () => {
    for (const [x, y, z] of [[90, 70, 6], [20, 20, 80], [80, 10, 40], [10, 60, 30]]) {
      const s = realSession();
      await s.dispatch("feature.primitive", { shape: "box", x: String(x), y: String(y), z: String(z), at: { x: 0, y: 0, z: z / 2 } });
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope));
      expect(pinAnchor(rows[0])!.z).toBeCloseTo(z, 3);
    }
  });

  it("extrudes the back and lip to the base's far face, and they follow it when the base widens", async () => {
    const s = realSession();
    const h = { dispatch: (t: string, p: Record<string, unknown>) => s.dispatch(t, p), doc: () => s.doc };
    await s.dispatch("parameter.add", { name: "width", expression: String(STAND.width) });
    await s.dispatch("feature.primitive", { shape: "box", x: "width", y: String(STAND.depth), z: String(STAND.base), at: { x: 0, y: 0, z: STAND.base / 2 } });
    const back = await sideSketch(h); await backProfile(h, back); await across(h, back);
    const lip = await sideSketch(h); await lipProfile(h, lip); await across(h, lip);
    const ext = Object.values(s.doc.features).filter((f) => f.kind === "extrude");
    expect(ext.map((f) => (f as { extent?: string }).extent)).toEqual(["toFace", "toFace"]);
    let b = bodies(s);
    expect(b.length).toBe(1);
    expect(b[0].bounds!.min.x).toBeCloseTo(-STAND.width / 2, 3);
    const v0 = b[0].volume!;
    const op = s.timeline.find((o) => o.type === "parameter.add")!;
    await s.editOperation(op.opId, { ...op.params, expression: "120" }); // the box grows both ways about its centre
    b = bodies(s);
    expect(b.length).toBe(1);
    expect(b[0].bounds!.min.x).toBeCloseTo(-60, 3);
    expect(b[0].bounds!.max.x).toBeCloseTo(60, 3);
    expect(b[0].volume! / v0).toBeCloseTo(120 / 90, 2); // every part is extruded across the full width
  });
});

describe("rounding the stand's corners (the zebra shot)", () => {
  it("Round corners on the base's top face rounds only its four vertical corners, generously", async () => {
    const { faceCornerSelector } = await import("../src/ui/concepts/contextActions.logic");
    const { s } = await build(false);
    const before = bodies(s)[0];
    const edges = faceCornerSelector({ x: 0, y: -STAND.depth / 2 + 4, z: STAND.base }, { x: 0, y: 0, z: 1 });
    const r = await s.dispatch("feature.fillet", { radius: "15", edges, body: before.featureId, requireEffect: true });
    expect(r.ok).toBe(true);
    const after = bodies(s);
    expect(after.length).toBe(1);
    // the base's footprint keeps its extents, the plate and lip are untouched, and material came off the corners
    expect(after[0].bounds!.max.z).toBeCloseTo(STAND.base + STAND.height, 3);
    expect(after[0].bounds!.min.x).toBeCloseTo(-STAND.width / 2, 3);
    const vol = (b: typeof before) => { const m = b.mesh!; let v = 0; for (let i = 0; i < m.indices.length; i += 3) { const [a, b2, c] = [0, 1, 2].map((k) => m.indices[i + k] * 3); const p = (j: number) => [m.positions[j], m.positions[j + 1], m.positions[j + 2]]; const [A, B, C] = [p(a), p(b2), p(c)]; v += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6; } return Math.abs(v); };
    const removed = vol(before) - vol(after[0]);
    const corners = 4 * (1 - Math.PI / 4) * 15 * 15 * STAND.base; // four corner cut-offs, base-high
    expect(Math.abs(removed / corners - 1)).toBeLessThan(0.02); // within the mesh's faceting
  }, 60000);
});
