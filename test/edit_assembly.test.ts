import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import type { CadSession } from "../src/core/command/session";

const L = 60, AXIS = { x: 0, y: -1, z: 0 };
async function dis(s: CadSession, type: string, params: Record<string, unknown>) {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r;
}

describe("editOperation on a jointed-pattern doc", () => {
  it("editing the theta parameter.add op updates the parameter", async () => {
    const s = realSession();
    const thetaRes = await dis(s, "parameter.add", { name: "theta", expression: "40", min: 18, max: 68 });
    await dis(s, "parameter.add", { name: "stages", expression: "3", min: 1, max: 8, step: 1 });
    const stage = (await dis(s, "component.create", { name: "Stage" })).createdIds![0];
    const mk = async (name: string) => {
      const c = (await dis(s, "component.create", { name, parent: stage })).createdIds![0];
      for (const [n, x] of [["bottom", 0], ["top", L], ["center", L / 2]] as [string, number][]) await dis(s, "component.connector", { component: c, name: n, origin: { x, y: 0, z: 0 } });
      return c;
    };
    const A = await mk("BarA"), B = await mk("BarB");
    const pat = (await dis(s, "assembly.pattern", { source: stage, count: "stages" })).createdIds![0];
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "theta", appliesTo: "first" });
    await dis(s, "joint.template", { pattern: pat, kind: "revolute", base: { role: "prev", component: B, port: "top" }, moved: { role: "self", component: A, port: "bottom" }, axis: AXIS, value: "2*theta - 180", appliesTo: "rest" });
    await s.recompute();

    // Find theta's parameter.add op and edit its expression, exactly as the store does.
    const op = s.timeline.find((o) => o.type === "parameter.add" && (o.params as { name?: string }).name === "theta")!;
    expect(op).toBeTruthy();
    const r = await s.editOperation(op.opId, { name: "theta", expression: "25", min: 18, max: 68 });
    expect(r.ok).toBe(true);
    const theta = s.doc.parameters.find((p) => p.name === "theta")!;
    expect(theta.expr).toBe("25");
    expect(theta.value).toBe(25);
    // the pattern + templates survived the edit/replay
    expect(Object.keys(s.doc.componentPatterns).length).toBe(1);
    expect(Object.keys(s.doc.jointTemplates).length).toBe(2);
    void thetaRes;
  });
});
