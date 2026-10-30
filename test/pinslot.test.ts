import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { resolveComponentWorld } from "../src/core/recompute";
import { applyPoint } from "../src/math/transform";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const DEG = Math.PI / 180;

describe("pin-slot joint (solved 1-DOF mechanism)", () => {
  it("solves the angle so the moved pin lands on the slot line", async () => {
    const s = realSession();
    const arm = (await dis(s, "component.create", { name: "Arm" }))[0];
    const L = 100, d = 60;
    // arm rotates about +Z at the origin; its tip (L,0,0) must stay on the
    // vertical line x = d (direction +Y). Solver should find θ = acos(d/L).
    await dis(s, "joint.create", {
      kind: "pin-slot", moved: arm,
      baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
      pin: { x: L, y: 0, z: 0 }, slotPoint: { x: d, y: 0, z: 0 }, slotDir: { x: 0, y: 1, z: 0 },
    });

    const W = resolveComponentWorld(s.doc, scopeOf(s)).get(arm)!;
    const pin = applyPoint(W, { x: L, y: 0, z: 0 });
    expect(pin.x).toBeCloseTo(d, 3);                                  // pin on the slot
    expect(Math.abs(pin.y)).toBeCloseTo(Math.sqrt(L * L - d * d), 2); // = L·sinθ
    const jnt = Object.values(s.doc.joints)[0];
    expect(Math.abs(jnt.valueValue)).toBeCloseTo(Math.acos(d / L) / DEG, 2);
  });

  it("tracks a slot that is driven by a parameter", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "gap", expression: "60" });
    const L = 120;
    // a carriage slides along +X by `gap`; the arm's tip must stay on a vertical
    // slot fixed to the carriage (carriage-local x = 0), so the pin tracks `gap`.
    const carriage = (await dis(s, "component.create", { name: "Carriage" }))[0];
    await dis(s, "joint.create", { kind: "slider", moved: carriage, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, value: "gap" });
    const arm = (await dis(s, "component.create", { name: "Arm" }))[0];
    await dis(s, "joint.create", {
      kind: "pin-slot", moved: arm, slotBase: carriage,
      baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
      pin: { x: L, y: 0, z: 0 }, slotPoint: { x: 0, y: 0, z: 0 }, slotDir: { x: 0, y: 1, z: 0 },
    });

    for (const g of [60, 40, 90, 20]) {
      await dis(s, "parameter.set", { name: "gap", expression: String(g) });
      const W = resolveComponentWorld(s.doc, scopeOf(s)).get(arm)!;
      const pin = applyPoint(W, { x: L, y: 0, z: 0 });
      expect(pin.x).toBeCloseTo(g, 2);                 // tip follows the moving slot
      expect(Math.hypot(pin.x, pin.y)).toBeCloseTo(L, 2); // arm stays rigid (length L)
    }
  });
});
