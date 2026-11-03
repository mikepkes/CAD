// The cylindrical and ball joints, joint stops, and couplings (gear / belt /
// rack): each poses its part by the right transform, persists through a save,
// stamps from a joint template, is swept by the motion study, and has its
// collisions found — a coupled joint's through the coupling, as its driver is
// swept. Couplings propagate ratio and sign, down a chain.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { InlineGeometryBackend, type GeometryBackend } from "../src/core/geometry/backend";
import { resolveComponentWorld, ballMotion, couplingOutput } from "../src/core/recompute";
import { resolveParameters } from "../src/core/parameters";
import { expandAssembly } from "../src/core/assembly";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { applyPoint, applyVec } from "../src/math/transform";
import { driveJoints, runMotionStudy, studyPoseCount, motionVerdict } from "../src/model/motionStudy";
import { describeDocument } from "../src/model/agent";
import { sweepPose } from "../src/viewport/motionGhosts";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const O = { x: 0, y: 0, z: 0 };
const Z = { x: 0, y: 0, z: 1 };

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}
const comp = async (s: CadSession, name: string) => (await dis(s, "component.create", { name }))[0];
const worlds = (s: CadSession) => resolveComponentWorld(s.doc, resolveParameters(s.doc.parameters).scope);
const at = (s: CadSession, c: string, p: { x: number; y: number; z: number }) => applyPoint(worlds(s).get(c)!, p);
const close = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => {
  expect(p.x).toBeCloseTo(q.x, 9); expect(p.y).toBeCloseTo(q.y, 9); expect(p.z).toBeCloseTo(q.z, 9);
};
const setParam = async (s: CadSession, name: string, expression: string) => {
  const op = s.timeline.find((o) => o.type === "parameter.add" && o.params.name === name)!;
  await s.editOperation(op.opId, { ...op.params, expression });
};

describe("cylindrical joint", () => {
  it("turns about its axis and slides along it, about the connector", async () => {
    const s = realSession();
    const c = await comp(s, "Shaft");
    await dis(s, "joint.create", { kind: "cylindrical", moved: c, baseOrigin: { x: 10, y: 0, z: 0 }, movedOrigin: O, axis: Z, value: "90", slide: "5" });
    // (1,0,0) seats at (11,0,0), turns 90° about the axis through (10,0,0) to (10,1,0), and rises 5
    close(at(s, c, { x: 1, y: 0, z: 0 }), { x: 10, y: 1, z: 5 });
    const j = Object.values(s.doc.joints)[0];
    expect(j.valueValue).toBe(90);
    expect(j.slideValue).toBe(5);
  });

  it("slides along a tilted axis by the axis' unit length, and both values follow parameters", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "spin", expression: "0" });
    await dis(s, "parameter.add", { name: "travel", expression: "10" });
    const c = await comp(s, "Tube");
    await dis(s, "joint.create", { kind: "cylindrical", moved: c, baseOrigin: O, movedOrigin: O, axis: { x: 0, y: 3, z: 4 }, value: "spin", slide: "travel" });
    close(at(s, c, O), { x: 0, y: 6, z: 8 });
    await setParam(s, "travel", "-5");
    await setParam(s, "spin", "180");
    close(at(s, c, O), { x: 0, y: -3, z: -4 });
    // a half turn about (0, .6, .8): (1,0,0) → (−1,0,0)
    const W = worlds(s).get(c)!;
    close(applyVec(W, { x: 1, y: 0, z: 0 }), { x: -1, y: 0, z: 0 });
  });

  it("holds each value at its stops", async () => {
    const s = realSession();
    const c = await comp(s, "Shaft");
    await dis(s, "joint.create", { kind: "cylindrical", moved: c, baseOrigin: O, movedOrigin: O, axis: Z, value: "200", slide: "60", limits: { value: { min: -90, max: 90 }, slide: { min: 0, max: 40 } } });
    const j = Object.values(s.doc.joints)[0];
    expect([j.valueValue, j.slideValue]).toEqual([90, 40]);
    close(at(s, c, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 40 });
  });

  it("refuses what isn't a cylindrical joint's", async () => {
    const s = realSession();
    const c = await comp(s, "Shaft");
    expect((await s.dispatch("joint.create", { kind: "revolute", moved: c, baseOrigin: O, movedOrigin: O, slide: "3" })).ok).toBe(false);
    expect((await s.dispatch("joint.create", { kind: "cylindrical", moved: c, baseOrigin: O, movedOrigin: O, slide: "nope +" })).ok).toBe(false);
    expect((await s.dispatch("joint.create", { kind: "cylindrical", moved: c, baseOrigin: O, movedOrigin: O, limits: { tilt: { max: 3 } } })).error).toMatch(/no "tilt"/);
    expect((await s.dispatch("joint.create", { kind: "cylindrical", moved: c, baseOrigin: O, movedOrigin: O, limits: { slide: { min: 5, max: 1 } } })).ok).toBe(false);
  });
});

describe("ball joint", () => {
  const ball = async (b: Record<string, unknown>, extra: Record<string, unknown> = {}, axis = Z) => {
    const s = realSession();
    const c = await comp(s, "Arm");
    await dis(s, "joint.create", { kind: "ball", moved: c, baseOrigin: { x: 0, y: 0, z: 50 }, movedOrigin: O, axis, ball: b, ...extra });
    return { s, c };
  };

  it("leans its axis by tilt toward heading", async () => {
    const { s, c } = await ball({ tilt: 30, heading: 90 });
    // the part's axis point (0,0,10) leans 30° toward +Y about the centre (0,0,50)
    close(at(s, c, { x: 0, y: 0, z: 10 }), { x: 0, y: 10 * Math.sin(Math.PI / 6), z: 50 + 10 * Math.cos(Math.PI / 6) });
    close(at(s, c, O), { x: 0, y: 0, z: 50 }); // the centre stays put
  });

  it("spins about its own axis, then swings", async () => {
    const spun = await ball({ spin: 90 });
    close(at(spun.s, spun.c, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 50 });
    const both = await ball({ tilt: 90, heading: 0, spin: 90 });
    close(at(both.s, both.c, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 50 });   // twisted to +Y, which the swing about Y keeps
    close(at(both.s, both.c, { x: 0, y: 0, z: 10 }), { x: 10, y: 0, z: 50 }); // the axis laid over toward +X
  });

  it("means nothing by heading at no tilt", async () => {
    const { s, c } = await ball({ tilt: 0, heading: 77 });
    close(at(s, c, { x: 3, y: 4, z: 5 }), { x: 3, y: 4, z: 55 });
  });

  it("keeps within its cone", async () => {
    const { s, c } = await ball({ tilt: 80, heading: 0 }, { limits: { tilt: { max: 30 } } });
    expect(Object.values(s.doc.joints)[0].ballValue?.tilt).toBe(30);
    close(at(s, c, { x: 0, y: 0, z: 10 }), { x: 5, y: 0, z: 50 + 10 * Math.cos(Math.PI / 6) });
  });

  it("measures heading from +Y when its axis lies along X", async () => {
    const { s, c } = await ball({ tilt: 90 }, {}, { x: 1, y: 0, z: 0 });
    close(at(s, c, { x: 10, y: 0, z: 0 }), { x: 0, y: 10, z: 50 });
  });

  it("is the same rotation whatever the axis length, and composes as swing·twist", () => {
    const a = ballMotion({ x: 0, y: 0, z: 2 }, { tilt: 40, heading: 30, spin: 15 }, O);
    const b = ballMotion(Z, { tilt: 40, heading: 30, spin: 15 }, O);
    close(applyVec(a, { x: 1, y: 2, z: 3 }), applyVec(b, { x: 1, y: 2, z: 3 }));
    const n = applyVec(b, Z), t = (40 * Math.PI) / 180, h = (30 * Math.PI) / 180;
    close(n, { x: Math.sin(t) * Math.cos(h), y: Math.sin(t) * Math.sin(h), z: Math.cos(t) });
  });

  it("refuses a solve, a slide, a negative cone", async () => {
    const s = realSession();
    const c = await comp(s, "Arm");
    expect((await s.dispatch("joint.create", { kind: "ball", moved: c, baseOrigin: O, movedOrigin: O, solve: true })).ok).toBe(false);
    expect((await s.dispatch("joint.create", { kind: "ball", moved: c, baseOrigin: O, movedOrigin: O, slide: 3 })).ok).toBe(false);
    expect((await s.dispatch("joint.create", { kind: "ball", moved: c, baseOrigin: O, movedOrigin: O, limits: { tilt: { max: -5 } } })).ok).toBe(false);
    expect((await s.dispatch("joint.create", { kind: "revolute", moved: c, baseOrigin: O, movedOrigin: O, ball: { tilt: 3 } })).ok).toBe(false);
  });
});

describe("couplings", () => {
  /** Revolute a (driven by `turn`), revolutes b, c, slider d, cylindrical e, revolute f. */
  async function train() {
    const s = realSession();
    await dis(s, "parameter.add", { name: "turn", expression: "30" });
    const j: Record<string, string> = {};
    for (const [k, kind] of [["a", "revolute"], ["b", "revolute"], ["c", "revolute"], ["d", "slider"], ["e", "cylindrical"], ["f", "revolute"]] as const) {
      const c = await comp(s, k.toUpperCase());
      j[k] = (await dis(s, "joint.create", { kind, moved: c, baseOrigin: O, movedOrigin: O, axis: kind === "slider" ? { x: 1, y: 0, z: 0 } : Z, value: k === "a" ? "turn" : "999", name: k }))[0];
    }
    const v = (k: string) => { worlds(s); return s.doc.joints[j[k]].valueValue; };
    return { s, j, v };
  }

  it("a gear turns the other way by the ratio, a belt the same way, and the driven joint's own value is unused", async () => {
    const { s, j, v } = await train();
    await dis(s, "joint.couple", { driver: j.a, driven: j.b, kind: "gear", ratio: 2 });
    await dis(s, "joint.couple", { driver: j.a, driven: j.c, kind: "belt", ratio: "1/3" });
    expect(v("b")).toBeCloseTo(-60, 12);
    expect(v("c")).toBeCloseTo(10, 12);
    expect(Object.values(s.doc.couplings!).map((c) => c.sign)).toEqual([-1, 1]);
  });

  it("propagates down a chain: gear → belt → rack (turn to slide) → rack (slide to turn)", async () => {
    const { s, j, v } = await train();
    await dis(s, "joint.couple", { driver: j.a, driven: j.b, kind: "gear", ratio: 2 });    // b = −2·30 = −60
    await dis(s, "joint.couple", { driver: j.b, driven: j.c, kind: "belt", ratio: "1/3" }); // c = −20
    await dis(s, "joint.couple", { driver: j.c, driven: j.d, kind: "rack", ratio: 36 });    // d = −20·36/360 = −2 mm
    await dis(s, "joint.couple", { driver: j.d, driven: j.e, kind: "rack", ratio: 36 });    // e = 360·(−2)/36 = −20°
    expect([v("b"), v("c"), v("d"), v("e")].map((x) => +x.toFixed(9))).toEqual([-60, -20, -2, -20]);
    // the drive moves, the whole train follows
    await setParam(s, "turn", "-90");
    expect([v("b"), v("c"), v("d"), v("e")].map((x) => +x.toFixed(9))).toEqual([180, 60, 6, 60]);
    // and the parts go where the values say: d slides along X
    const dComp = Object.values(s.doc.joints).find((x) => x.name === "d")!.moved;
    close(at(s, dComp, O), { x: 6, y: 0, z: 0 });
  });

  it("takes a sign and an offset, and drives a cylindrical joint's slide", async () => {
    const { s, j, v } = await train();
    await dis(s, "joint.couple", { driver: j.a, driven: j.f, kind: "gear", ratio: 1, sign: 1, offset: "10" }); // f = 10 + 30
    await dis(s, "joint.couple", { driver: j.a, driven: j.e, kind: "rack", ratio: 12 });                     // picks e's slide: 30·12/360 = 1
    expect(v("f")).toBeCloseTo(40, 12);
    expect(s.doc.joints[j.e].slideValue).toBeCloseTo(1, 12);
    expect(Object.values(s.doc.couplings!)[1].drivenDof).toBe("slide");
    // e's angle is still its own (999), and can be coupled separately
    expect(v("e")).toBe(999);
    await dis(s, "joint.couple", { driver: j.a, driven: j.e, kind: "belt", ratio: 2 });
    expect(v("e")).toBeCloseTo(60, 12);
  });

  it("stops a coupled joint at its stops, and the train after it with it", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "turn", expression: "100" });
    const [a, b, c] = [await comp(s, "A"), await comp(s, "B"), await comp(s, "C")];
    const ja = (await dis(s, "joint.create", { kind: "revolute", moved: a, baseOrigin: O, movedOrigin: O, value: "turn" }))[0];
    const jb = (await dis(s, "joint.create", { kind: "revolute", moved: b, baseOrigin: O, movedOrigin: O, limits: { value: { min: -45, max: 45 } } }))[0];
    const jc = (await dis(s, "joint.create", { kind: "revolute", moved: c, baseOrigin: O, movedOrigin: O }))[0];
    await dis(s, "joint.couple", { driver: ja, driven: jb, kind: "belt", ratio: 1 });
    await dis(s, "joint.couple", { driver: jb, driven: jc, kind: "gear", ratio: 1 });
    worlds(s);
    expect([s.doc.joints[jb].valueValue, s.doc.joints[jc].valueValue]).toEqual([45, -45]);
  });

  it("refuses a loop, a second driver, like to unlike, and joints with nothing to drive", async () => {
    const { s, j } = await train();
    await dis(s, "joint.couple", { driver: j.a, driven: j.b });
    await dis(s, "joint.couple", { driver: j.b, driven: j.c });
    expect((await s.dispatch("joint.couple", { driver: j.c, driven: j.a })).error).toMatch(/loop/);
    expect((await s.dispatch("joint.couple", { driver: j.f, driven: j.b })).error).toMatch(/already driven/);
    expect((await s.dispatch("joint.couple", { driver: j.a, driven: j.d, kind: "gear" })).error).toMatch(/like to like/);
    expect((await s.dispatch("joint.couple", { driver: j.a, driven: j.f, kind: "rack", ratio: 10 })).error).toMatch(/turn to a slide/);
    expect((await s.dispatch("joint.couple", { driver: j.a, driven: j.a })).ok).toBe(false);
    expect((await s.dispatch("joint.couple", { driver: j.a, driven: j.d, kind: "rack", ratio: 0 })).ok).toBe(false);
    const r = await comp(s, "R");
    const rigid = (await dis(s, "joint.create", { moved: r, baseOrigin: O, movedOrigin: O }))[0];
    expect((await s.dispatch("joint.couple", { driver: rigid, driven: j.f })).ok).toBe(false);
    expect((await s.dispatch("joint.couple", { driver: j.f, driven: rigid })).ok).toBe(false);
  });

  it("reports a loop made later instead of hanging", async () => {
    const { s, j, v } = await train();
    await dis(s, "joint.couple", { driver: j.a, driven: j.b });
    // hand-edit the recipe into a loop (b drives a, a drives b): placing must still finish, and say so
    s.doc.couplings!.loop = { id: "loop", name: "loop", kind: "gear", driver: j.b, driven: j.a, ratioExpr: "1", ratioValue: 1, sign: -1 };
    v("a");
    expect(Object.values(s.doc.couplings!).some((c) => c.error?.includes("loop"))).toBe(true);
  });

  it("does the rack sums both ways", () => {
    const c = { kind: "rack" as const, ratioValue: 36, sign: 1 as const };
    expect(couplingOutput(c, 90, true, false)).toBe(9);
    expect(couplingOutput(c, 9, false, true)).toBe(90);
    expect(couplingOutput({ ...c, kind: "gear", sign: -1, ratioValue: 0.5 }, 90, true, true, 5)).toBe(-40);
  });
});

describe("persistence and templates", () => {
  it("saves and reopens every new kind, its stops and couplings, posed the same", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "turn", expression: "40" });
    const [a, b, c, d] = [await comp(s, "A"), await comp(s, "B"), await comp(s, "C"), await comp(s, "D")];
    const ja = (await dis(s, "joint.create", { kind: "cylindrical", moved: a, baseOrigin: { x: 5, y: 0, z: 0 }, movedOrigin: O, axis: Z, value: "turn", slide: "turn/10", limits: { slide: { min: 0, max: 3 } } }))[0];
    await dis(s, "joint.create", { kind: "ball", moved: b, base: a, baseOrigin: { x: 0, y: 0, z: 20 }, movedOrigin: O, ball: { tilt: "turn/2", heading: 45, spin: 10 }, limits: { tilt: { max: 15 } } });
    const jc = (await dis(s, "joint.create", { kind: "revolute", moved: c, baseOrigin: { x: 30, y: 0, z: 0 }, movedOrigin: O }))[0];
    const jd = (await dis(s, "joint.create", { kind: "slider", moved: d, baseOrigin: O, movedOrigin: O, axis: { x: 0, y: 1, z: 0 } }))[0];
    await dis(s, "joint.couple", { driver: ja, driven: jc, kind: "gear", ratio: "3/2", offset: 5 });
    await dis(s, "joint.couple", { driver: jc, driven: jd, kind: "rack", ratio: "pi*2*10" });
    const before = worlds(s);
    const back = sessionFromDoc(deserializeDocument(serializeDocument(s.doc)));
    await back.recompute();
    const after = worlds(back);
    expect(Object.values(back.doc.joints).map((j) => j.kind)).toEqual(["cylindrical", "ball", "revolute", "slider"]);
    expect(Object.values(back.doc.joints)[1]).toMatchObject({ ball: { tilt: "turn/2", heading: "45", spin: "10" }, limits: { tilt: { max: 15 } } });
    expect(Object.values(back.doc.couplings!).map((c) => [c.kind, c.ratioExpr, c.sign, c.offsetExpr])).toEqual([["gear", "3/2", -1, "5"], ["rack", "pi*2*10", 1, undefined]]);
    for (const id of [a, b, c, d]) close(applyPoint(after.get(id)!, { x: 1, y: 2, z: 3 }), applyPoint(before.get(id)!, { x: 1, y: 2, z: 3 }));
    expect(back.doc.joints[ja].slideValue).toBe(3); // 40/10, held at its stop
  });

  it("stamps cylindrical and ball joints from templates, per instance", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "n", expression: "3" });
    const seg = await comp(s, "Segment");
    await dis(s, "component.connector", { component: seg, name: "top", origin: { x: 0, y: 0, z: 10 } });
    await dis(s, "component.connector", { component: seg, name: "bottom", origin: O });
    const pat = (await dis(s, "assembly.pattern", { source: seg, count: "n" }))[0];
    await dis(s, "joint.template", { pattern: pat, kind: "cylindrical", base: { role: "root", origin: O }, moved: { role: "self", component: seg, port: "bottom" }, value: "0", slide: "2", appliesTo: "first", limits: { slide: { max: 1 } } });
    await dis(s, "joint.template", { pattern: pat, kind: "ball", base: { role: "prev", component: seg, port: "top" }, moved: { role: "self", component: seg, port: "bottom" }, ball: { tilt: "10*i", heading: 90 }, appliesTo: "rest" });
    expect((await s.dispatch("joint.template", { pattern: pat, kind: "revolute", base: { role: "root" }, moved: { role: "self", component: seg }, slide: 1 })).ok).toBe(false);
    const scope = resolveParameters(s.doc.parameters).scope;
    const ex = expandAssembly(s.doc, scope);
    const js = Object.values(ex.joints);
    expect(js.map((j) => j.kind)).toEqual(["cylindrical", "ball", "ball"]);
    expect(js[0]).toMatchObject({ slideExpr: "2", limits: { slide: { max: 1 } } });
    expect(js.slice(1).map((j) => j.ball?.tilt)).toEqual(["10*(1)", "10*(2)"]);
    // a chain leaning toward +Y: the third segment's top is the second's tilted 10° then the third's 20° more... about each joint
    const W = resolveComponentWorld(ex, scope);
    const top = (i: number) => applyPoint(W.get(`${pat}#${i}__${seg}`)!, { x: 0, y: 0, z: 10 });
    close(top(0), { x: 0, y: 0, z: 11 }); // slid 2, held at 1
    const t1 = (10 * Math.PI) / 180, t2 = (20 * Math.PI) / 180;
    close(top(1), { x: 0, y: 10 * Math.sin(t1), z: 11 + 10 * Math.cos(t1) });
    // the second ball joint is in the tilted segment's frame: its lean adds to the first's
    close(top(2), { x: 0, y: 10 * Math.sin(t1) + 10 * Math.sin(t1 + t2), z: 11 + 10 * Math.cos(t1) + 10 * Math.cos(t1 + t2) });
  });

  it("describes joints and couplings for the agent", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "turn", expression: "10" });
    const [a, b] = [await comp(s, "A"), await comp(s, "B")];
    const ja = (await dis(s, "joint.create", { kind: "cylindrical", moved: a, baseOrigin: O, movedOrigin: O, value: "turn", slide: 4, name: "Shaft" }))[0];
    const jb = (await dis(s, "joint.create", { kind: "revolute", moved: b, baseOrigin: O, movedOrigin: O, name: "Gear" }))[0];
    const cid = (await dis(s, "joint.couple", { driver: ja, driven: jb, ratio: 2 }))[0];
    worlds(s);
    const d = describeDocument(s.doc, "model", null) as { joints: Record<string, unknown>[]; couplings: Record<string, unknown>[] };
    expect(d.joints[0]).toMatchObject({ id: ja, kind: "cylindrical", value: { expr: "turn", value: 10 }, slide: { expr: "4", value: 4 } });
    expect(d.joints[1]).toMatchObject({ id: jb, value: { by: cid, value: -20 } });
    expect(d.couplings[0]).toMatchObject({ id: cid, kind: "gear", driver: ja, driven: jb, ratio: "2", sign: -1 });
  });
});

describe("the motion study's drives", () => {
  async function rig() {
    const s = realSession();
    for (const n of ["spin", "travel", "lean", "dir", "twist", "free"]) await dis(s, "parameter.add", { name: n, expression: "0" });
    const [a, b, c, d] = [await comp(s, "A"), await comp(s, "B"), await comp(s, "C"), await comp(s, "D")];
    await dis(s, "joint.create", { kind: "cylindrical", moved: a, baseOrigin: O, movedOrigin: O, value: "spin", slide: "travel", limits: { slide: { min: 0, max: 40 } } });
    await dis(s, "joint.create", { kind: "ball", moved: b, baseOrigin: O, movedOrigin: O, ball: { tilt: "lean", heading: "dir", spin: "twist" }, limits: { tilt: { max: 30 } } });
    const jc = (await dis(s, "joint.create", { kind: "revolute", moved: c, baseOrigin: O, movedOrigin: O, value: "free" }))[0];
    const jd = (await dis(s, "joint.create", { kind: "slider", moved: d, baseOrigin: O, movedOrigin: O, value: "free" }))[0];
    return { s, jc, jd };
  }

  it("sweeps an unlimited angle round a full turn, a travel or a limited angle between its stops, and a heading at the cone's edge", async () => {
    const { s } = await rig();
    const drives = driveJoints(s.doc);
    expect(drives.map((d) => [d.param, d.motion, d.from, d.to, d.unit])).toEqual([
      ["spin", "turn", 0, 360, "°"], ["travel", "slide", 0, 40, "mm"], ["lean", "range", 0, 30, "°"], ["dir", "turn", 0, 360, "°"], ["twist", "turn", 0, 360, "°"], ["free", "turn", 0, 360, "°"],
    ]);
    expect(drives.find((d) => d.param === "dir")?.hold).toEqual({ lean: 30 });
    expect(motionVerdict(s.doc, { status: "pass", worstOverlap: 0 })).toBe("All 6 joints move through their full range with nothing in the way");
  });

  it("leaves out a travel with no stops, and a joint a coupling drives", async () => {
    const { s, jc, jd } = await rig();
    // the slider reads `free` too, but has no stops: only the revolute's turn of it is a drive
    expect(driveJoints(s.doc).filter((d) => d.param === "free").map((d) => d.kind)).toEqual(["revolute"]);
    await dis(s, "joint.couple", { driver: Object.keys(s.doc.joints)[0], driven: jc, kind: "belt" });
    expect(driveJoints(s.doc).map((d) => d.param)).not.toContain("free");
    void jd;
  });

  it("poses each drive through its range, the rest pose once", async () => {
    const { s } = await rig();
    const seen: Record<string, string>[] = [];
    const backend = { collide: async (_d: unknown, o?: Record<string, string>) => { seen.push({ ...o! }); return { maxOverlap: 0, overlaps: [] }; } } as unknown as GeometryBackend;
    const r = await runMotionStudy(backend, s.doc, { steps: 5, coarse: 5 });
    expect(r?.status).toBe("pass");
    const drives = driveJoints(s.doc);
    expect(seen.length).toBe(studyPoseCount(drives, 5));
    expect(seen.filter((o) => Object.values(o).every((v) => v === "0")).length).toBe(1);
    expect(seen.filter((o) => o.travel !== "0").map((o) => +o.travel)).toEqual([10, 20, 30, 40]); // 0..40, ends included
    expect(seen.filter((o) => o.dir !== "0" || o.lean === "30").every((o) => o.lean === "30")).toBe(true); // heading swept leaning over
    expect(seen.filter((o) => o.lean === "30" && o.dir !== "0").map((o) => +o.dir)).toEqual([72, 144, 216, 288]);
    // the drawn sweep follows the same ranges
    expect(sweepPose(drives, (1 + 0.5) / drives.length)).toMatchObject({ travel: "20", spin: "0" });
    expect(sweepPose(drives, (3 + 0.5) / drives.length)).toMatchObject({ dir: "180", lean: "30" });
  });

  it("names a slide's failing pose in mm", async () => {
    const { s } = await rig();
    const backend = { collide: async (_d: unknown, o?: Record<string, string>) => (+o!.travel >= 30 ? { maxOverlap: 5, overlaps: [{ a: "A", b: "Wall", volume: 5 }] } : { maxOverlap: 0, overlaps: [] }) } as unknown as GeometryBackend;
    const r = await runMotionStudy(backend, s.doc, { steps: 5 });
    expect(r?.reason).toBe("A hits Wall at travel = 30 mm");
  });
});

// Real geometry: the parts collide through the new joints, and through a coupling.
describe("collisions through the new joints", () => {
  const geo = new InlineGeometryBackend();
  beforeAll(async () => { await geo.init({ wasmBinary: wasm }); }, 60000);

  /** A box body in component `c` (or the root), corners (x0,y0,z0)–(x1,y1,z1). */
  async function box(s: CadSession, c: string | undefined, name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const sid = (await dis(s, "sketch.create", { plane: "XY", offset: z0, ...(c ? { component: c } : {}), name }))[0];
    await dis(s, "sketch.addRectangle", { sketch: sid, corner: { x: x0, y: y0 }, opposite: { x: x1, y: y1 } });
    await dis(s, "feature.extrude", { sketch: sid, distance: String(z1 - z0), name });
  }

  it("a cylindrical shaft sliding into a stop collides at the end of its travel, not before", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "spin", expression: "0" });
    await dis(s, "parameter.add", { name: "travel", expression: "0" });
    const c = await comp(s, "Shaft");
    await box(s, c, "Shaft", -5, -5, 0, 5, 5, 10);
    await box(s, undefined, "Stop", -20, -20, 40, 20, 20, 50);
    const j = (await dis(s, "joint.create", { kind: "cylindrical", moved: c, baseOrigin: O, movedOrigin: O, value: "spin", slide: "travel", limits: { slide: { min: 0, max: 45 } } }))[0];
    await s.recompute();
    // 0, 5 … 45 mm, coarse first (0, 15, 25, 40): at 40 it's in the stop (at 30 it only touches)
    const r = await runMotionStudy(geo, s.doc, { steps: 10 });
    expect(r?.status).toBe("fail");
    expect(r?.reason).toMatch(/(Shaft hits Stop|Stop hits Shaft) at travel = 40 mm/);
    // with its travel stopped short of the block, it's clear all the way (and turning)
    const op = s.timeline.find((o) => o.createdIds.includes(j))!;
    await s.editOperation(op.opId, { ...op.params, limits: { slide: { min: 0, max: 25 } } });
    expect((await runMotionStudy(geo, s.doc, { steps: 6 }))?.status).toBe("pass");
  }, 120000);

  it("a ball joint's arm swung round its cone finds the post beside it", async () => {
    const s = realSession();
    for (const n of ["lean", "dir"]) await dis(s, "parameter.add", { name: n, expression: "0" });
    const c = await comp(s, "Arm");
    await box(s, c, "Arm", -3, -3, 5, 3, 3, 40);
    await box(s, undefined, "Post", -5, 22, 0, 5, 30, 40); // off to +Y
    await dis(s, "joint.create", { kind: "ball", moved: c, baseOrigin: O, movedOrigin: O, ball: { tilt: "lean", heading: "dir" }, limits: { tilt: { max: 50 } } });
    await s.recompute();
    expect((await geo.collide(s.doc)).maxOverlap).toBeLessThan(0.01); // upright: clear
    const r = await runMotionStudy(geo, s.doc, { steps: 8, coarse: 4 });
    // leaning toward +X (heading 0) it is clear; swept round at the cone's edge it meets the post at +Y
    expect(r?.status).toBe("fail");
    expect(r?.reason).toMatch(/at dir = 90°/);
  }, 120000);

  it("a rack driven by a coupling from a swept turn hits the wall it's carried into", async () => {
    const s = realSession();
    await dis(s, "parameter.add", { name: "spin", expression: "0" });
    const [pin, rack] = [await comp(s, "Pinion"), await comp(s, "Rack")];
    await box(s, rack, "Rack", -5, -5, 0, 5, 5, 10);
    await box(s, undefined, "Wall", 33, -10, 0, 40, 10, 10);
    const jp = (await dis(s, "joint.create", { kind: "revolute", moved: pin, baseOrigin: { x: 0, y: 30, z: 0 }, movedOrigin: O, value: "spin" }))[0];
    const jr = (await dis(s, "joint.create", { kind: "slider", moved: rack, baseOrigin: O, movedOrigin: O, axis: { x: 1, y: 0, z: 0 } }))[0];
    await dis(s, "joint.couple", { driver: jp, driven: jr, kind: "rack", ratio: 36 }); // 36 mm a turn: 30 mm at 300°
    await s.recompute();
    expect(driveJoints(s.doc).map((d) => d.param)).toEqual(["spin"]); // the rack isn't a drive: it follows
    const r = await runMotionStudy(geo, s.doc, { steps: 12 });
    expect(r?.status).toBe("fail");
    expect(r?.reason).toMatch(/(Rack hits Wall|Wall hits Rack) at spin = 300°/);
  }, 120000);
});
