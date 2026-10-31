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
