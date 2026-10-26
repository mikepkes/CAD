import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { materialForComponent } from "../src/core/document";
import { woodFrameFromBounds, SPECIES_KEYS, createMaterial } from "../src/viewport/material";
import type { CadSession } from "../src/core/command/session";

async function dis(s: CadSession, type: string, params: Record<string, unknown>) {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

describe("material system", () => {
  it("creates materials and resolves assignment by inheritance", async () => {
    const s = realSession();
    const oak = (await dis(s, "material.create", { name: "Oak", kind: "wood", species: "white-oak" }))[0];
    const steel = (await dis(s, "material.create", { name: "Steel", kind: "metal", finish: "satin" }))[0];
    const parent = (await dis(s, "component.create", { name: "Assembly" }))[0];
    const child = (await dis(s, "component.create", { name: "Part", parent }))[0];
    const screw = (await dis(s, "component.create", { name: "Screw", parent: child }))[0];

    await dis(s, "material.assign", { material: oak });            // root default
    await dis(s, "material.assign", { material: steel, component: screw });

    // child inherits the root default; screw has its own; an override on `parent` wins for child
    expect(materialForComponent(s.doc, child)?.name).toBe("Oak");
    expect(materialForComponent(s.doc, screw)?.name).toBe("Steel");
    const walnut = (await dis(s, "material.create", { name: "Walnut", kind: "wood", species: "walnut" }))[0];
    await dis(s, "material.assign", { material: walnut, component: parent });
    expect(materialForComponent(s.doc, child)?.name).toBe("Walnut"); // nearest ancestor
    expect(materialForComponent(s.doc, screw)?.name).toBe("Steel");  // own still wins
  });

  it("every species preset builds a wood material without throwing", () => {
    expect(SPECIES_KEYS.length).toBeGreaterThan(5);
    for (const sp of SPECIES_KEYS) {
      const m = createMaterial({ kind: "wood", species: sp }, { axis: [1, 0, 0], pith: [0, -300, 0] });
      expect(m).toBeTruthy();
      expect((m as { userData: Record<string, unknown> }).userData.woodUniforms).toBeTruthy();
    }
    expect(createMaterial({ kind: "metal", finish: "polished" })).toBeTruthy();
    expect(createMaterial({ kind: "plastic", color: "#206040" })).toBeTruthy();
  });

  it("wood frame picks grain along the longest axis", () => {
    const board = woodFrameFromBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 1700, y: 78, z: 90 } }, "b1");
    expect(board.axis).toEqual([1, 0, 0]); // long axis = X
    const leg = woodFrameFromBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 90, y: 90, z: 800 } }, "leg");
    expect(leg.axis).toEqual([0, 0, 1]); // long axis = Z (vertical grain)
  });
});
