import { describe, it, expect } from "vitest";
import { createDocument } from "../src/core/document";
import { metricsOf, intentScope, checkIntents, parseIntent, intentText, headroom } from "../src/model/concepts/intents";

const solid = (id: string, volume: number, max: { x: number; y: number; z: number }) =>
  ({ featureId: id, name: id, mesh: {} as never, volume, bounds: { min: { x: 0, y: 0, z: 0 }, max } }) as never;

describe("intents", () => {
  it("derives metrics from the solids (mass at the given density, bounds over every body)", () => {
    const m = metricsOf({ a: solid("a", 10000, { x: 40, y: 20, z: 5 }), b: solid("b", 2000, { x: 10, y: 60, z: 30 }) }, 2.7);
    expect(m.volume).toBe(12000);
    expect(m.mass).toBeCloseTo(32.4, 6);
    expect([m.width, m.depth, m.height]).toEqual([40, 60, 30]);
    expect(m.bodies).toBe(2);
    expect(metricsOf({}).width).toBe(0);
  });

  it("parses, prints and checks comparisons over parameters and metrics", () => {
    const doc = createDocument();
    doc.parameters.push({ id: "p1", name: "wall", expr: "3", value: 3 } as never);
    const scope = intentScope(doc, metricsOf({ a: solid("a", 40000, { x: 1, y: 1, z: 1 }) }));
    const intents = [
      parseIntent("mass <= 120", "i1", "Mass")!,
      parseIntent("wall >= 4", "i2")!,
      parseIntent("wall*2 == 6", "i3")!,
      parseIntent("nope < 1", "i4")!,
    ];
    expect(intentText(intents[0])).toBe("mass <= 120");
    expect(intents[1].label).toBe("wall");
    const r = checkIntents(intents, scope);
    expect(r.map((x) => x.ok)).toEqual([true, false, true, false]);
    expect(r[0].lhs).toBeCloseTo(108, 6);
    expect(headroom(r[0])).toBeCloseTo(12, 6);
    expect(headroom(r[1])).toBe(-1);
    expect(r[3].error).toBeTruthy();
    expect(parseIntent("just words", "x")).toBeNull();
  });
});
