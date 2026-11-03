import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initKernel, threadRod, buildThread, volumeOfShape, boundsOfShape } from "../src/core/occ/kernel";

// A modelled thread rod is built once per spec and kept (seconds of sweeping and booleans for a
// long one): the same spec gives the same rod as building it afresh, a different spec its own,
// and a spec that can't form fails the same way every time without being swept again.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

describe("thread rods by spec", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("builds a spec once, and gives what building it afresh gives", () => {
    const spec = { form: "metric" as const, pitch: 1.5, majorDiameter: 10, length: 12 };
    const a = threadRod(spec);
    expect(threadRod({ ...spec })).toBe(a); // the same spec, the same rod
    const fresh = buildThread(spec);
    expect(volumeOfShape(a)).toBe(volumeOfShape(fresh));
    expect(boundsOfShape(a)).toEqual(boundsOfShape(fresh));
    fresh.delete();
    const longer = threadRod({ ...spec, length: 20 });
    expect(longer).not.toBe(a);
    expect(volumeOfShape(longer)).toBeGreaterThan(volumeOfShape(a));
    expect(threadRod({ ...spec, leftHand: true })).not.toBe(a);
  }, 60000);

  it("keeps a failure too", () => {
    const bad = { form: "metric" as const, pitch: 1.5, majorDiameter: 10, length: 0 };
    expect(() => threadRod(bad)).toThrow(/length must be positive/);
    expect(() => threadRod(bad)).toThrow(/length must be positive/);
  });
});
