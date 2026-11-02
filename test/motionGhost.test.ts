// Motion ghosts: while a motion study runs, the viewport draws the parts it moves sweeping round, see-through, at
// display rate (each drive in turn through a full circle, paced by the check running behind). The poses are placed
// from the joints (never rebuilt), and only the parts a pose moves are ghosted, the leading pose strongest and its
// wake fading. The study itself names each pose before checking it, the all-at-rest pose once.
import { describe, it, expect } from "vitest";
import { runMotionStudy, poseCount } from "../src/model/motionStudy";
import { motionGhostPoses, movedComponents, trailStrength, sweepPose, sweepTrail, SweepPace } from "../src/viewport/motionGhosts";
import { IDENTITY, type Rigid } from "../src/math/transform";
import { realSession } from "./helpers";
import type { GeometryBackend } from "../src/core/geometry/backend";
import type { CadSession } from "../src/core/command/session";

const clear = { maxOverlap: 0, overlaps: [] };
const backend = (seen: Record<string, string>[]): GeometryBackend => ({
  init: async () => {}, ready: () => true, evaluate: async () => ({ solids: {}, facePlanes: {} }), edges: async () => [], exportBytes: async () => null, dispose: () => {},
  collide: async (_d: unknown, o?: Record<string, string>) => { seen.push(o!); return clear; },
} as never);

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds?.[0] as string;
}

/** A frame, a ring that turns on it about Z by `spin`, and a gimbal that turns in the ring about X by `tilt`. */
async function gyro() {
  const s = realSession();
  await dis(s, "parameter.add", { name: "spin", expression: "0" });
  await dis(s, "parameter.add", { name: "tilt", expression: "0" });
  const frame = await dis(s, "component.create", { name: "Frame" });
  const ring = await dis(s, "component.create", { name: "Ring" });
  const gimbal = await dis(s, "component.create", { name: "Gimbal" });
  const o = { x: 0, y: 0, z: 0 };
  await dis(s, "joint.create", { kind: "revolute", base: frame, moved: ring, baseOrigin: o, movedOrigin: o, axis: { x: 0, y: 0, z: 1 }, value: "spin" });
  await dis(s, "joint.create", { kind: "revolute", base: ring, moved: gimbal, baseOrigin: o, movedOrigin: o, axis: { x: 1, y: 0, z: 0 }, value: "tilt" });
  return { s, frame, ring, gimbal };
}

describe("the study names each pose as it checks it", () => {
  it("in the order checked: the swept drive at its angle, the others at 0", async () => {
    const doc = { id: "d", joints: { a: { kind: "revolute", valueExpr: "spin" }, b: { kind: "revolute", valueExpr: "tilt" } },
      parameters: [{ id: "spin", name: "spin", expr: "30", value: 30 }, { id: "tilt", name: "tilt", expr: "0", value: 0 }] } as never;
    const named: Record<string, string>[] = [], seen: Record<string, string>[] = [];
    await runMotionStudy(backend(seen), doc, { steps: 4, coarse: 2, onPose: (o) => named.push({ ...o }) });
    expect(named).toEqual(seen); // each before its check
    // every drive at 0 is one pose, checked once (on the first drive's turn)
    expect(named.slice(0, 3)).toEqual([{ spin: "0", tilt: "0" }, { spin: "180", tilt: "0" }, { tilt: "180", spin: "0" }]);
    expect(named).toHaveLength(poseCount(2, 4));
    expect(poseCount(2, 4)).toBe(7);
    expect(poseCount(1, 8)).toBe(8);
    expect(poseCount(0, 8)).toBe(0);
  });
});

describe("the sweep drawn while the check runs", () => {
  it("tours every drive in turn through a full circle, the others at 0", () => {
    const drives = ["spin", "tilt"];
    expect(sweepPose(drives, 0)).toEqual({ spin: "0", tilt: "0" });
    expect(sweepPose(drives, 0.25)).toEqual({ spin: "180", tilt: "0" });
    expect(sweepPose(drives, 0.5)).toEqual({ spin: "0", tilt: "0" });
    expect(sweepPose(drives, 0.625)).toEqual({ spin: "0", tilt: "90" });
    expect(sweepPose(drives, 1)).toEqual({ spin: "0", tilt: "360" });
  });
  it("a short wake behind the leading pose, along the drive turning now only", () => {
    const drives = ["spin", "tilt"];
    expect(sweepTrail(drives, 0.25, 4, 12).map((o) => o.spin)).toEqual(["180", "168", "156", "144"]);
    // just into the tilt's turn: no wake from the spin's turn before it
    expect(sweepTrail(drives, 0.5 + 15 / 720, 4, 12)).toEqual([{ spin: "0", tilt: "15" }, { spin: "0", tilt: "3" }]);
    expect(sweepTrail([], 0.3)).toEqual([]);
  });
  it("moves at a steady pace that ends the tour when the check is due to end", () => {
    // 10 poses at 500 ms each: the check ends at 5000 ms
    const pace = new SweepPace(0, 10, 4000);
    const at: number[] = [];
    for (let t = 0; t <= 5000; t += 50) at.push(pace.advance(t, Math.floor(t / 500) / 10));
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1]);
    expect(at.at(-1)).toBeGreaterThan(0.97);
    // steady once the check's pace is known: equal steps per frame, not a jump per pose checked
    const steps = at.slice(30, 90).map((a, i) => at[30 + i + 1] - a);
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.3);
  });
  it("waits on a check slower than its guess rather than finishing early", () => {
    const pace = new SweepPace(0, 10, 2000);
    let at = 0;
    for (let t = 0; t <= 3000; t += 50) at = pace.advance(t, 0); // the first pose still not checked after 3 s
    expect(at).toBeLessThan(0.2);
  });
});

describe("the trail", () => {
  it("draws the pose being checked strongest and fades the older ones", () => {
    expect(trailStrength(0, 1)).toBe(1);
    const n = 4, s = Array.from({ length: n }, (_, i) => trailStrength(i, n));
    expect(s[0]).toBe(1);
    for (let i = 1; i < n; i++) expect(s[i]).toBeLessThan(s[i - 1]);
    expect(s[n - 1]).toBeGreaterThan(0); // the oldest is faint, not gone
  });
  it("ghosts only what a pose moves", () => {
    const turned: Rigid = { ...IDENTITY, x: { x: 0, y: 1, z: 0 }, y: { x: -1, y: 0, z: 0 } };
    const build = new Map([["frame", IDENTITY], ["ring", IDENTITY]]);
    const posed = new Map([["frame", { ...IDENTITY }], ["ring", turned]]);
    expect([...movedComponents(build, posed).keys()]).toEqual(["ring"]);
  });
});

describe("poses placed from the joints", () => {
  it("each pose as the components it moves: a ring turned, the gimbal it carries with it, the frame left out", async () => {
    const { s, frame, ring, gimbal } = await gyro();
    const { build, poses } = motionGhostPoses(s.doc, [{ spin: "90", tilt: "0" }, { spin: "0", tilt: "0" }, { tilt: "90", spin: "0" }]);
    expect(build.has(frame)).toBe(true);
    // the built pose itself moves nothing, so it is dropped; the others keep their place in the fade
    expect(poses).toHaveLength(2);
    expect(poses[0].strength).toBe(1);
    expect([...poses[0].world.keys()].sort()).toEqual([ring, gimbal].sort());
    expect(poses[0].world.get(ring)!.x.y).toBeCloseTo(1); // turned a quarter about Z
    expect([...poses[1].world.keys()]).toEqual([gimbal]); // the tilt moves only the gimbal
    expect(poses[1].strength).toBeLessThan(poses[0].strength);
  });
  it("leaves the joints as the built pose has them", async () => {
    const { s } = await gyro();
    motionGhostPoses(s.doc, [{ spin: "nonsense(", tilt: "0" }, { spin: "45", tilt: "0" }]);
    for (const j of Object.values(s.doc.joints)) expect(j.error).toBeFalsy();
  });
});
