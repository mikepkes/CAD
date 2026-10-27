// Parametric positions: sketch points, datum planes and connectors whose
// coordinates are expressions in the document's parameters.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { expandAssembly } from "../src/core/assembly";
import { placeComponentSketches, resolveComponentWorld } from "../src/core/recompute";
import { resolveParameters } from "../src/model/parameters";
import { applyPoint } from "../src/math/transform";
import { to3d, resolveSketchPlane } from "../src/geometry/plane";
import type { CadSession } from "../src/core/command/session";
import type { SketchPoint } from "../src/sketch/types";

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

describe("expression-positioned sketch points", () => {
  it("follow their parameters, and drag the geometry built on them along", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "w", expression: "40" });
    const sk = (await dis(s, "sketch.create", { plane: "XY" }))[0];
    const p = (await dis(s, "sketch.addPoint", { sketch: sk, x: "w/2", y: "w/4 + 1" }))[0];
    const [, , end] = await dis(s, "sketch.addLine", { sketch: sk, start: { x: 0, y: 0 }, end: { ref: p } });
    await s.recompute();
    let pt = s.doc.sketches[sk].entities[p] as SketchPoint;
    expect([pt.x, pt.y, pt.fixed]).toEqual([20, 11, true]);
    await dis(s, "parameter.set", { name: "w", expression: "60" });
    await s.recompute();
    pt = s.doc.sketches[sk].entities[p] as SketchPoint;
    expect([pt.x, pt.y]).toEqual([30, 16]);
    expect(end).toBe(p); // the line's end IS the parametric point
  });

  it("rejects a coordinate that doesn't evaluate", async () => {
    const s = realSession();
    const sk = (await dis(s, "sketch.create", { plane: "XY" }))[0];
    const r = await s.dispatch("sketch.addPoint", { sketch: sk, x: "nope*2", y: 0 });
    expect(r.ok).toBe(false);
  });
});

describe("point-and-normal datum planes", () => {
  it("sit where their origin expressions say, square to their normal", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "d", expression: "10" });
    const n = { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 };
    const pl = (await dis(s, "plane.create", { origin: { x: "d", y: "2*d", z: 5 }, normal: n }))[0];
    const sk = (await dis(s, "sketch.create", { datum: pl }))[0];
    await s.recompute();
    const at = () => to3d(resolveSketchPlane(s.doc.sketches[sk]), 0, 0);
    expect(at()).toEqual({ x: 10, y: 20, z: 5 });
    const wp = resolveSketchPlane(s.doc.sketches[sk]);
    expect(wp.normal.x).toBeCloseTo(n.x, 12);
    // sketch "up" is world up for a horizontal normal
    expect(wp.v.x).toBeCloseTo(0, 12); expect(wp.v.y).toBeCloseTo(0, 12); expect(wp.v.z).toBeCloseTo(1, 12);
    await dis(s, "parameter.set", { name: "d", expression: "3" });
    await s.recompute();
    expect(at()).toEqual({ x: 3, y: 6, z: 5 });
  });

  it("needs both origin and normal", async () => {
    const s = realSession();
    expect((await s.dispatch("plane.create", { origin: { x: 0, y: 0, z: 0 } })).ok).toBe(false);
  });
});

describe("expression connector origins", () => {
  it("move a pattern instance seated on them as the parameter changes", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "h", expression: "10" });
    const part = (await dis(s, "component.create", { name: "Part" }))[0];
    await dis(s, "component.connector", { component: part, name: "seat", origin: { x: 0, y: 0, z: 0 } });
    await dis(s, "component.connector", { component: part, name: "flip", origin: { x: 0, y: 0, z: "2*h" } });
    const pat = (await dis(s, "assembly.pattern", { source: part, count: 2 }))[0];
    await dis(s, "joint.template", { pattern: pat, kind: "rigid", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: part, port: "seat" }, appliesTo: "first" });
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: part, port: "flip" }, axis: { x: 0, y: 1, z: 0 }, value: "180", appliesTo: "rest" });
    const flipped = async (h: number) => {
      await dis(s, "parameter.set", { name: "h", expression: String(h) });
      await s.recompute();
      const scope = resolveParameters(s.doc.parameters).scope;
      const doc = expandAssembly(s.doc, scope);
      placeComponentSketches(doc, scope);
      return applyPoint(resolveComponentWorld(doc, scope).get(`${pat}#1__${part}`)!, { x: 1, y: 0, z: 0 });
    };
    // the copy is flipped about the Y axis and seated so z → 2h − z
    const a = await flipped(10), b = await flipped(7);
    expect(a.x).toBeCloseTo(-1, 9); expect(a.z).toBeCloseTo(20, 9);
    expect(b.z).toBeCloseTo(14, 9);
  });
});

describe("boolean parameters", () => {
  it("are 0/1 switches that drive expressions, and stop being switches when given new extents", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "both", expression: "1", boolean: true });
    await dis(s, "parameter.add", { name: "count", expression: "1 + both" });
    await s.recompute();
    const p = () => s.doc.parameters.find((q) => q.name === "both")!;
    expect(p()).toMatchObject({ boolean: true, values: [0, 1], value: 1 });
    expect(s.doc.parameters.find((q) => q.name === "count")!.value).toBe(2);
    await dis(s, "parameter.set", { name: "both", expression: "0" });
    await s.recompute();
    expect(s.doc.parameters.find((q) => q.name === "count")!.value).toBe(1);
    await dis(s, "parameter.setBounds", { name: "both", min: 0, max: 5 });
    expect(p().boolean).toBeUndefined();
    expect(p().values).toBeUndefined();
  });

  it("can be made from an existing parameter, snapping its value to 0 or 1", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "lid", expression: "7", min: 0, max: 10 });
    await dis(s, "parameter.add", { name: "off", expression: "0.5 - 0.5" });
    await dis(s, "parameter.setBounds", { name: "lid", boolean: true });
    await dis(s, "parameter.setBounds", { name: "off", boolean: true });
    await s.recompute();
    const p = (n: string) => s.doc.parameters.find((q) => q.name === n)!;
    expect(p("lid")).toMatchObject({ boolean: true, values: [0, 1], value: 1 });
    expect(p("lid").min).toBeUndefined();
    expect(p("off")).toMatchObject({ boolean: true, value: 0 });
    expect((await s.dispatch("parameter.setBounds", { name: "lid", boolean: true, max: 3 })).ok).toBe(false);
  });

  it("take no extents or value list", async () => {
    const s = realSession();
    expect((await s.dispatch("parameter.add", { name: "b", expression: "1", boolean: true, min: 0, max: 1 })).ok).toBe(false);
  });
});
