import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, type SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";
import { featureRows } from "../src/model/concepts/featureCatalog";
import { pushTargetOf, pushTo, pushEdit, namedParam, suggestParamName, paramNameProblem } from "../src/ui/concepts/workbench/workbench";
import { newSolidCentre, faceEdgeSelector } from "../src/ui/concepts/contextActions.logic";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

const built = (s: CadSession) => Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope)).filter((b) => b.mesh);
const rowsOf = (s: CadSession) => featureRows(s.doc, s.timeline, s.rollbackIndex, {});
const apply = async (s: CadSession, e: ReturnType<typeof pushTo>) => {
  if (e.kind === "op") await s.editOperation(e.opId, e.params);
  else { const op = s.timeline.find((o) => o.type === "parameter.add" && o.params.name === e.name)!; await s.editOperation(op.opId, { ...op.params, expression: e.expr }); }
};
const bounds = (b: SolidEval) => b.bounds!;

describe("direct modelling: Push/Pull moves the face you grabbed", () => {
  it("pushes a box's +X face out while the -X face stays", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20", at: { x: 0, y: 0, z: 10 } });
    const row = rowsOf(s)[0];
    const t = pushTargetOf(row, { x: 1, y: 0, z: 0 })!;
    expect(t.param.key).toBe("x");
    expect(t.shift).toEqual({ axis: "x", sign: 1 });
    await apply(s, pushTo(row, t, 50));
    const b = bounds(built(s)[0]);
    expect(b.min.x).toBeCloseTo(-20, 6);
    expect(b.max.x).toBeCloseTo(30, 6);
  });

  it("pulls the -Z face up, keeping the top where it was", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20", at: { x: 0, y: 0, z: 10 } });
    const row = rowsOf(s)[0];
    const e = pushEdit(row, -1, { x: 0, y: 0, z: -1 })!; // one step in: the bottom rises by the step
    await apply(s, e);
    const b = bounds(built(s)[0]);
    expect(b.max.z).toBeCloseTo(20, 6);
    expect(b.min.z).toBeGreaterThan(0);
  });

  it("drives a cylinder's height from its end and its radius from its side", () => {
    const s = realSession();
    return s.dispatch("feature.primitive", { shape: "cylinder", radius: "10", height: "30" }).then(() => {
      const row = rowsOf(s)[0];
      expect(pushTargetOf(row, { x: 0, y: 0, z: 1 })).toMatchObject({ param: { key: "height" }, shift: { axis: "z", sign: 1 } });
      expect(pushTargetOf(row, { x: 0.6, y: 0.8, z: 0 })).toMatchObject({ param: { key: "radius" } });
      expect(pushTargetOf(row, { x: 0.6, y: 0.8, z: 0 })!.shift).toBeUndefined();
    });
  });

  it("moves the parameter, not the link, when the number is named", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "depth", expression: "40" });
    await s.dispatch("feature.primitive", { shape: "box", x: "depth", y: "40", z: "20", at: { x: 0, y: 0, z: 10 } });
    const row = rowsOf(s).find((r) => r.spec.kind === "primitive")!;
    const e = pushTo(row, pushTargetOf(row, { x: 1, y: 0, z: 0 })!, 55, ["depth"]);
    expect(e).toEqual({ kind: "param", name: "depth", expr: "55" });
    await apply(s, e);
    const box = s.timeline.find((o) => o.type === "feature.primitive")!;
    expect(box.params.x).toBe("depth"); // still linked
    expect(bounds(built(s)[0]).max.x - bounds(built(s)[0]).min.x).toBeCloseTo(55, 6);
  });

  it("leaves other features to their own push param", async () => {
    const s = realSession();
    const sk = await s.dispatch("sketch.create", { plane: "XY" });
    await s.dispatch("sketch.addRectangle", { sketch: sk.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
    await s.dispatch("feature.extrude", { sketch: sk.createdIds[0], distance: "10" });
    const row = rowsOf(s)[0];
    expect(pushTargetOf(row, { x: 1, y: 0, z: 0 })).toMatchObject({ param: { key: "distance" } });
    expect(pushTargetOf(row, { x: 1, y: 0, z: 0 })!.shift).toBeUndefined();
  });
});

describe("rounding a face's edges", () => {
  it("names a face square to an axis by its plane, and nothing else", () => {
    expect(faceEdgeSelector({ x: 3, y: 4, z: 20 }, { x: 0, y: 0, z: 1 })).toEqual({ inPlane: { plane: "XY", offset: 20 } });
    expect(faceEdgeSelector({ x: 3, y: -20, z: 5 }, { x: 0, y: -1, z: 0 })).toEqual({ inPlane: { plane: "XZ", offset: 20 } });
    expect(faceEdgeSelector({ x: 20, y: 0, z: 5 }, { x: 1, y: 0, z: 0 })).toEqual({ inPlane: { plane: "YZ", offset: 20 } });
    expect(faceEdgeSelector({ x: 0, y: 0, z: 0 }, { x: 0.7, y: 0, z: 0.7 })).toBeNull();
  });

  it("fillets exactly the top face's outline of a box", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20", at: { x: 0, y: 0, z: 10 } });
    const before = built(s)[0].volume!;
    const r = await s.dispatch("feature.fillet", { radius: "2", edges: faceEdgeSelector({ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 1 })!, requireEffect: true });
    expect(r.ok).toBe(true);
    const after = built(s)[0];
    expect(after.volume!).toBeLessThan(before);
    expect(bounds(after).max.z).toBeCloseTo(20, 6); // rounded, not shrunk
  });
});

describe("naming numbers and placing new solids", () => {
  it("knows a dial from a literal or a formula", () => {
    expect(namedParam("depth", ["depth"])).toBe("depth");
    expect(namedParam(" depth ", ["depth"])).toBe("depth");
    expect(namedParam("40", ["depth"])).toBeNull();
    expect(namedParam("depth + 2", ["depth"])).toBeNull();
    expect(namedParam("pi", ["depth"])).toBeNull();
  });
  it("suggests a free name from the label and explains a bad one", () => {
    expect(suggestParamName("Distance", [])).toBe("distance");
    expect(suggestParamName("X", ["x"])).toBe("x2");
    expect(suggestParamName("Inner radius", [])).toBe("innerRadius");
    expect(suggestParamName("2nd", [])).toBe("n2nd");
    expect(paramNameProblem("depth", [])).toBeNull();
    expect(paramNameProblem("2d", [])).toMatch(/letters/);
    expect(paramNameProblem("depth", ["depth"])).toMatch(/already/);
  });
  it("drops a new solid on the floor, beside what is built", () => {
    expect(newSolidCentre([], 20, 20)).toEqual({ x: 0, y: 0, z: 10 });
    expect(newSolidCentre([{ min: { x: -20, y: 0, z: 0 }, max: { x: 30, y: 5, z: 9 } }], 10, 30)).toEqual({ x: 50, y: 0, z: 15 });
  });
});
