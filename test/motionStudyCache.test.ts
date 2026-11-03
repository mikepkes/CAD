// The motion study builds the bodies once: at every other pose a body the joints only move is replayed from the
// study's cache, moved to where the pose puts it, rather than rebuilt. The verdict must not change: at every pose
// a study checks, the cached check finds the same collisions (the same pairs, the same volumes) and the same build
// errors as a full rebuild — on the gyroscope, the motor, and a gear pair (whose sharp proxy and annuli, what the
// check rules pairs out with, must move with the replayed gear), clear and jammed.
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deserializeDocument } from "../src/core/persistence";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { collidePose, studyCache } from "../src/core/geometry/backend";
import { driveParams, sampleOrder } from "../src/model/motionStudy";
import type { CollisionResult } from "../src/core/features";
import type { CadDocument } from "../src/core/document";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function example(name: string): Promise<CadDocument> {
  const s = sessionFromDoc(deserializeDocument(readFileSync(fileURLToPath(new URL(`../public/examples/${name}.json`, import.meta.url)), "utf8")));
  await s.recompute();
  return s.doc;
}

/** The poses a study checks, in its order (store.ts: 8 steps round each drive, coarse 4 first, all-at-rest once). */
function studyPoses(doc: CadDocument, steps = 8): Record<string, string>[] {
  const drives = driveParams(doc), { first, rest } = sampleOrder(steps, 4), out: Record<string, string>[] = [];
  for (const pass of [first, rest]) {
    drives.forEach((j, i) => {
      for (const k of pass) {
        if (k === 0 && i > 0) continue;
        out.push(Object.fromEntries(drives.map((d) => [d, d === j ? String((360 * k) / steps) : "0"])));
      }
    });
  }
  return out;
}

const verdict = (r: CollisionResult) => ({
  buildError: r.buildError,
  pairs: r.overlaps.map((o) => `${o.aId}~${o.bId}`).sort(),
});

/** Check `poses` both ways; the cached check gives what the rebuild does, and replays the bodies after the first pose. */
function compare(doc: CadDocument, poses: Record<string, string>[]) {
  const cache = studyCache();
  let missesAfterFirst = 0;
  poses.forEach((o, i) => {
    const before = cache.misses;
    const rebuilt = collidePose(doc, o);
    const cached = collidePose(doc, o, cache);
    if (i > 0) missesAfterFirst += cache.misses - before;
    const at = JSON.stringify(o);
    expect(verdict(cached), at).toEqual(verdict(rebuilt));
    expect(cached.maxOverlap, at).toBeCloseTo(rebuilt.maxOverlap, 3);
    for (const [k, p] of cached.overlaps.entries()) expect(p.volume, at).toBeCloseTo(rebuilt.overlaps[k].volume, 3);
  });
  return { hits: cache.hits, missesAfterFirst };
}

describe("the motion study's cache: the same verdict as rebuilding, without the rebuild", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("the gyroscope: every ring turned, its bodies built once", async () => {
    const doc = await example("gyroscope");
    const poses = studyPoses(doc);
    expect(poses).toHaveLength(15);
    const { hits, missesAfterFirst } = compare(doc, poses);
    expect(hits).toBeGreaterThan(0);
    expect(missesAfterFirst).toBe(0); // the joints only move the rings: nothing rebuilt after the first pose
  }, 300000);

  it("the motor", async () => {
    const doc = await example("motor");
    expect(driveParams(doc).length).toBeGreaterThan(0);
    const { hits } = compare(doc, studyPoses(doc));
    expect(hits).toBeGreaterThan(0);
  }, 300000);

  it("a gear pair, turning clear and jammed half a tooth out", async () => {
    const s = realSession();
    const dis = async (type: string, params: Record<string, unknown>) => { const r = await s.dispatch(type, params); if (!r.ok) throw new Error(`${type}: ${r.error}`); return r.createdIds ?? []; };
    await dis("parameter.add", { name: "t", expression: "0" });
    await dis("parameter.add", { name: "slip", expression: "0" });
    // each gear in its own component, on a revolute joint about its centre (as test/gearSolid.test.ts)
    const gearOn = async (name: string, params: Record<string, unknown>, value: string) => {
      const comp = (await dis("component.create", { name }))[0];
      const id = (await dis("feature.gear", { component: comp, name, ...params }))[0];
      const d = (s.doc.features[id] as unknown as { dims: Record<string, string> }).dims;
      const at = { x: d.x ?? 0, y: d.y ?? 0, z: 0 };
      await dis("joint.create", { kind: "revolute", moved: comp, baseOrigin: at, movedOrigin: at, axis: { x: 0, y: 0, z: 1 }, value });
      return id;
    };
    const a = await gearOn("A", { type: "spur", module: 2, teeth: 19, faceWidth: 6, rotation: 4 }, "t");
    await gearOn("B", { type: "spur", teeth: 13, faceWidth: 6, mesh: { gear: a, angle: 65 } }, "-t*19/13 + slip");
    await s.recompute();
    const poses = [0, 7, 19, 41, 90].map((t) => ({ t: String(t) }));
    expect(compare(s.doc, poses).hits).toBeGreaterThan(0);
    await jam(s);
    const jammed = studyCache();
    const r = collidePose(s.doc, { t: "0" }, jammed), r2 = collidePose(s.doc, { t: "45" }, jammed);
    expect(r.maxOverlap).toBeGreaterThan(1); // the check still fails a jam
    expect(verdict(r2)).toEqual(verdict(collidePose(s.doc, { t: "45" })));
    expect(r2.maxOverlap).toBeCloseTo(collidePose(s.doc, { t: "45" }).maxOverlap, 3);
  }, 300000);
});

async function jam(s: CadSession) {
  const r = await s.dispatch("parameter.set", { name: "slip", expression: String(180 / 13) });
  if (!r.ok) throw new Error(r.error);
  await s.recompute();
}
