// The motion check (V8): coarse poses first, then the ones between; a verdict
// worded by the kind of motion checked; verdicts kept per set of values.
import { describe, it, expect } from "vitest";
import { runMotionStudy, sampleOrder, motionKey, motionVerdict, driveJoints } from "../src/model/motionStudy";
import type { GeometryBackend } from "../src/core/geometry/backend";

const docWith = (joints: Record<string, { kind: string; valueExpr: string }>, params: { name: string; expr?: string; label?: string }[], id = "d1") => ({
  id, joints, parameters: params.map((p) => ({ id: p.name, name: p.name, expr: p.expr ?? "0", value: 0, ...(p.label ? { label: p.label } : {}) })),
} as any);
const backend = (collide: (o: Record<string, string>) => { maxOverlap: number; overlaps: { a: string; b: string; volume: number }[] }, seen: string[] = []): GeometryBackend => ({
  init: async () => {}, ready: () => true, evaluate: async () => ({ solids: {}, facePlanes: {} }), edges: async () => [], exportBytes: async () => null, dispose: () => {},
  collide: async (_d: unknown, o?: Record<string, string>) => { seen.push(o!.spin); return collide(o!); },
} as never);

describe("coarse first, then refine", () => {
  it("spreads the first poses round the turn, then fills in", () => {
    expect(sampleOrder(8, 4)).toEqual({ first: [0, 2, 4, 6], rest: [1, 3, 5, 7] });
    expect(sampleOrder(12, 4)).toEqual({ first: [0, 3, 6, 9], rest: [1, 2, 4, 5, 7, 8, 10, 11] });
    expect(sampleOrder(3, 4)).toEqual({ first: [0, 1, 2], rest: [] });
  });
  it("checks every 90° first, says so, then the 45°s", async () => {
    const seen: string[] = [];
    const coarse: [number, number][] = [];
    const doc = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin" }]);
    const r = await runMotionStudy(backend(() => ({ maxOverlap: 0, overlaps: [] }), seen), doc, { steps: 8, coarse: 4, onCoarseClear: (a, b) => coarse.push([a, b]) });
    expect(r?.status).toBe("pass");
    expect(seen).toEqual(["0", "90", "180", "270", "45", "135", "225", "315"]);
    expect(coarse).toEqual([[4, 8]]);
  });
  it("a jam in the coarse pass fails at once, without the rest", async () => {
    const seen: string[] = [];
    const doc = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin", label: "Ring" }]);
    const r = await runMotionStudy(backend((o) => (o.spin === "90" ? { maxOverlap: 9, overlaps: [{ a: "Ring 2", b: "Frame", volume: 9 }] } : { maxOverlap: 0, overlaps: [] }), seen), doc, { steps: 8, coarse: 4 });
    expect(r).toMatchObject({ status: "fail", reason: "Ring 2 hits Frame at Ring = 90°" }); // the drive by its label
    expect(seen).toEqual(["0", "90"]);
  });
});

describe("the verdict in words", () => {
  it("says what moved, by the kind of joint, not always \"Rotates freely\"", () => {
    const one = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin" }]);
    expect(motionVerdict(one, { status: "pass", worstOverlap: 0 })).toBe("Turns a full circle with nothing in the way");
    const named = docWith({ j: { kind: "revolute", valueExpr: "turn" } }, [{ name: "turn", label: "Knob" }]);
    expect(motionVerdict(named, { status: "pass", worstOverlap: 0 })).toBe("Knob turns a full circle with nothing in the way");
    const three = docWith({ a: { kind: "revolute", valueExpr: "s1" }, b: { kind: "revolute", valueExpr: "s2" }, c: { kind: "revolute", valueExpr: "s3" } }, [{ name: "s1" }, { name: "s2" }, { name: "s3" }]);
    expect(motionVerdict(three, { status: "pass", worstOverlap: 0 })).toBe("All 3 joints turn a full circle with nothing in the way");
    expect(motionVerdict(one, { status: "fail", reason: "Ring 2 hits Frame at spin = 90°", worstOverlap: 9 })).toBe("Ring 2 hits Frame at spin = 90°");
    expect(driveJoints(three).map((d) => d.kind)).toEqual(["revolute", "revolute", "revolute"]);
  });
});

describe("verdicts kept per set of values", () => {
  it("keys on every parameter but the swept drives, and on the design", () => {
    const a = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin", expr: "0" }, { name: "gap", expr: "6" }]);
    const turned = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin", expr: "120" }, { name: "gap", expr: "6" }]);
    const wider = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin", expr: "0" }, { name: "gap", expr: "8" }]);
    const other = docWith({ j: { kind: "revolute", valueExpr: "spin" } }, [{ name: "spin", expr: "0" }, { name: "gap", expr: "6" }], "d2");
    expect(motionKey(turned)).toBe(motionKey(a)); // turning the drive itself needs no new check
    expect(motionKey(wider)).not.toBe(motionKey(a));
    expect(motionKey(other)).not.toBe(motionKey(a));
  });
});
