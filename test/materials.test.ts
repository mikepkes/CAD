// Materials: the new kinds (rubber, printed), their fields, and material.update.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { densityOf } from "../src/model/concepts/intents";
import { materialSpec } from "../src/viewport/material";
import { acrossLayers, allowableFor } from "../src/sim/flexure";
import type { Joint, Material } from "../src/core/document";

describe("materials", () => {
  it("creates a printed material with its layers, build direction and strength across layers", async () => {
    const s = realSession();
    const r = await s.dispatch("material.create", { name: "PLA", kind: "printed", layerHeight: 0.16, printAxis: "x", youngsModulus: 3500, allowableStrain: 0.02, layerFactor: 0.5 });
    expect(r.ok).toBe(true);
    const m = s.doc.materials[r.createdIds[0]];
    expect(m).toMatchObject({ kind: "printed", layerHeight: 0.16, printAxis: "x", mechanical: { E: 3500, allowableStrain: 0.02, layerFactor: 0.5 } });
    expect(materialSpec(m)).toEqual({ kind: "printed", layerHeight: 0.16, printAxis: "x" });
    expect(densityOf(m).density).toBe(1.2);
  });

  it("rubber takes a texture, and has a rubber density", async () => {
    const s = realSession();
    const r = await s.dispatch("material.create", { name: "Grip", kind: "rubber", texture: "knurl", textureScale: 2 });
    const m = s.doc.materials[r.createdIds[0]];
    expect(materialSpec(m)).toEqual({ kind: "rubber", texture: "knurl", textureScale: 2 });
    expect(densityOf(m).density).toBe(1.15);
    expect((await s.dispatch("material.create", { name: "Bad", kind: "rubber", texture: "plaid" })).ok).toBe(false);
  });

  it("layerFactor needs the mechanical properties it scales", async () => {
    const s = realSession();
    const r = await s.dispatch("material.create", { name: "PLA", kind: "printed", layerFactor: 0.5 });
    expect(r.message).toMatch(/layerFactor needs youngsModulus/);
    expect(Object.keys(s.doc.materials)).toHaveLength(0);
  });

  it("material.update changes fields, keeps the rest, and undoes", async () => {
    const s = realSession();
    const id = (await s.dispatch("material.create", { name: "PLA", kind: "printed", color: "#ffffff", youngsModulus: 3500, allowableStrain: 0.02 })).createdIds[0];
    expect((await s.dispatch("material.update", { material: id, printAxis: "y", name: "PLA, on its side", layerFactor: 0.4 })).ok).toBe(true);
    expect(s.doc.materials[id]).toMatchObject({ name: "PLA, on its side", printAxis: "y", color: "#ffffff", mechanical: { E: 3500, allowableStrain: 0.02, layerFactor: 0.4 } });
    s.undo();
    expect(s.doc.materials[id].printAxis).toBeUndefined();
    expect((await s.dispatch("material.update", { material: "nope", color: "#000000" })).ok).toBe(false);
  });

  it("a print's flexures are weaker pulled across its layers: by the strip's direction against the build direction", () => {
    // a beam strip running along X, from (0,0) to (40,0) in the base's plane
    const beam = { id: "j", name: "Blade", kind: "flexure", base: "a", moved: "b", baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 40, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, beam: { thickness: 0.8, width: 6 } } as unknown as Joint;
    const pla = (printAxis: "x" | "y" | "z"): Material => ({ id: "m", name: "PLA", kind: "printed", printAxis, mechanical: { E: 3500, allowableStrain: 0.02, layerFactor: 0.5 } });
    expect(acrossLayers(beam, "x")).toBe(1);   // printed along the strip: every fibre pulls across a layer line
    expect(acrossLayers(beam, "y")).toBe(0);
    expect(acrossLayers(beam, "z")).toBe(0);
    expect(allowableFor(beam, pla("x"))).toBeCloseTo(0.01, 9);   // half the strain before it splits between layers
    expect(allowableFor(beam, pla("z"))).toBeCloseTo(0.02, 9);   // flat on the bed: along the layers, full strength
    // a strip at 45° to the build direction: halfway in compliance
    const diag = { ...beam, movedOrigin: { x: 30, y: 30, z: 0 } } as Joint;
    expect(allowableFor(diag, pla("x"))).toBeCloseTo(0.02 / (0.5 / 0.5 + 0.5), 9);
    // a hinge bending about Z: printed along Z it's pulled only along its layers; along X, taken at its worst
    const hinge = { ...beam, beam: undefined, flexure: { length: 2, width: 6, thickness: 0.6 } } as unknown as Joint;
    expect(allowableFor(hinge, pla("z"))).toBeCloseTo(0.02, 9);
    expect(allowableFor(hinge, pla("x"))).toBeCloseTo(0.01, 9);
    // not a print, or no layer factor: the plain limit
    expect(allowableFor(beam, { ...pla("x"), kind: "plastic" })).toBe(0.02);
    expect(allowableFor(beam, { id: "m", name: "PLA", kind: "printed", printAxis: "x", mechanical: { E: 3500, allowableStrain: 0.02 } })).toBe(0.02);
  });
});
