// Proposals 1–4: feature.primitive, sketch.addProfile (lines+arcs), per-body
// targeting on finishing features, and requireEffect (loud no-ops).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/model/parameters";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import type { CadSession } from "../src/core/command/session";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const evalAll = (s: CadSession): Record<string, SolidEval> => evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
const bodies = (s: CadSession) => Object.values(evalAll(s)).filter((b) => b.mesh);
const rows = (s: CadSession) => Object.values(evalAll(s));
const PI = Math.PI;

describe("proposal 1 — feature.primitive", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds each primitive with the right volume, centred on `at`", async () => {
    const box = realSession();
    await box.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20" });
    expect(bodies(box)[0].volume).toBeCloseTo(40 * 40 * 20, 1);
    const b = bodies(box)[0].bounds!;
    expect(b.min.z).toBeCloseTo(-10, 6); // centred on origin
    expect(b.max.z).toBeCloseTo(10, 6);

    const cyl = realSession();
    await cyl.dispatch("feature.primitive", { shape: "cylinder", radius: "8", height: "50" });
    expect(bodies(cyl)[0].volume!).toBeCloseTo(PI * 64 * 50, 0);

    const cone = realSession();
    await cone.dispatch("feature.primitive", { shape: "cone", radius: "10", height: "20" });
    expect(bodies(cone)[0].volume!).toBeCloseTo((PI * 100 * 20) / 3, 0);

    const sph = realSession();
    await sph.dispatch("feature.primitive", { shape: "sphere", radius: "10" });
    expect(bodies(sph)[0].volume!).toBeCloseTo((4 / 3) * PI * 1000, 0);

    const tor = realSession();
    await tor.dispatch("feature.primitive", { shape: "torus", radius: "20", tube: "4" });
    expect(bodies(tor)[0].volume!).toBeCloseTo(2 * PI * PI * 20 * 16, 0);
  });

  it("drills a hole as a primitive cut (one call, no sketch)", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20" });
    await s.dispatch("feature.primitive", { shape: "cylinder", radius: "5", height: "100", operation: "cut" });
    const v = bodies(s)[0].volume!;
    expect(v).toBeCloseTo(40 * 40 * 20 - PI * 25 * 20, 0);
  });

  it("survives a save/load round-trip", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "cylinder", radius: "8", height: "50" });
    const reload = sessionFromDoc(deserializeDocument(serializeDocument(s.doc)));
    await reload.recompute();
    expect(bodies(reload)[0].volume!).toBeCloseTo(PI * 64 * 50, 0);
  });
});

describe("proposal 2 — sketch.addProfile (lines + arcs)", () => {
  it("revolves a quarter-disk (radius-arc) into a hemisphere", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
    await s.dispatch("sketch.addProfile", { sketch: sid, segments: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10, radius: 10, ccw: true }] });
    await s.dispatch("feature.revolve", { sketch: sid, axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } });
    expect(bodies(s)[0].volume!).toBeCloseTo((2 / 3) * PI * 1000, 0); // hemisphere r=10
  });

  it("extrudes a half-disk from a 3-point (via) arc that closes onto the start", async () => {
    const s = realSession();
    const sid = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    // start (-10,0) → line → (10,0) → arc through (0,10) back to the start
    const r = await s.dispatch("sketch.addProfile", { sketch: sid, segments: [{ x: -10, y: 0 }, { x: 10, y: 0 }, { x: -10, y: 0, via: { x: 0, y: 10 } }] });
    expect(r.ok).toBe(true);
    await s.dispatch("feature.extrude", { sketch: sid, distance: "5" });
    expect(bodies(s)[0].volume!).toBeCloseTo((PI * 100) / 2 * 5, 0); // half-disk × 5
  });
});

describe("proposal 3 — per-body targeting on finishing features", () => {
  it("fillets a specific earlier body, leaving the newer one untouched", async () => {
    const s = realSession();
    const a = (await s.dispatch("feature.primitive", { shape: "box", x: "20", y: "20", z: "20", at: { x: -30, y: 0, z: 0 } })).createdIds[0];
    await s.dispatch("feature.primitive", { shape: "box", x: "20", y: "20", z: "20", at: { x: 30, y: 0, z: 0 } }); // body B (newest)
    await s.dispatch("feature.fillet", { radius: "3", body: a }); // target the OLDER body by id
    const r = evalAll(s);
    const bodyA = r[a];
    const bodyB = Object.values(r).find((x) => x.featureId !== a && x.mesh)!;
    expect(bodyA.volume!).toBeLessThan(8000);          // A rounded
    expect(bodyB.volume!).toBeCloseTo(8000, 1);         // B pristine
  });

  it("errors clearly when the named body doesn't exist", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "10", y: "10", z: "10" });
    await s.dispatch("feature.fillet", { radius: "1", body: "nope" });
    expect(rows(s).some((r) => /no body "nope"/.test(r.error ?? ""))).toBe(true);
  });
});

describe("proposal 4 — requireEffect (loud no-ops)", () => {
  async function missingCut(requireEffect: boolean) {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "40", z: "20", at: { x: 0, y: 0, z: 10 } });
    // a cut cylinder placed far away — misses the body entirely
    await s.dispatch("feature.primitive", { shape: "cylinder", radius: "3", height: "10", at: { x: 500, y: 0, z: 10 }, operation: "cut", requireEffect });
    return rows(s);
  }
  it("a no-op cut is a warning by default, an error with requireEffect", async () => {
    const warned = await missingCut(false);
    expect(warned.some((r) => r.warning && /changed nothing/.test(r.warning))).toBe(true);
    expect(warned.some((r) => r.error)).toBe(false);

    const errored = await missingCut(true);
    expect(errored.some((r) => r.error && /changed nothing/.test(r.error))).toBe(true);
  });

  it("a fillet that matches no edges is loud (errors, never a silent pass)", async () => {
    const s = realSession();
    await s.dispatch("feature.primitive", { shape: "box", x: "20", y: "20", z: "20" });
    await s.dispatch("feature.fillet", { radius: "1", edges: { inPlane: { plane: "XY", offset: 999 } } });
    expect(rows(s).some((r) => r.error && /no edge|changed nothing/i.test(r.error))).toBe(true);
  });
});
