import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initKernel, isKernelReady, buildPrimitive, volumeOfShape } from "../src/core/occ/kernel";

// A worker of the pool is handed the kernel's wasm compiled already (by the page, once for all of
// them) and instantiates it as it is: the kernel it makes is a whole one.
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

describe("a kernel from a compiled module", () => {
  it("loads and builds", async () => {
    const wasmModule = await WebAssembly.compile(wasm);
    await initKernel({ wasmModule });
    expect(isKernelReady()).toBe(true);
    const box = buildPrimitive({ shape: "box", at: { x: 0, y: 0, z: 0 }, x: 10, y: 20, z: 30 });
    expect(volumeOfShape(box)).toBeCloseTo(6000, 6);
    box.delete();
  }, 60000);
});
