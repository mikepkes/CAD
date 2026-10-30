import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { groupCutList, cutListCsv } from "../src/core/weldment";
import { bodyVisible } from "../src/core/visibility";
import type { CadSession } from "../src/core/command/session";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCadMcpServer } from "../mcp/server";

// Weldments: profiles laid along a layout sketch's lines, corners mitred or
// butted, end caps and gussets, and the cut list.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const evalAll = (s: CadSession) => {
  const out = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
  const errs = Object.values(out).filter((r) => r.error);
  if (errs.length) throw new Error(errs.map((r) => r.error).join("; "));
  return out;
};
const members = (s: CadSession): SolidEval[] => Object.values(evalAll(s)).filter((b) => b.mesh);
const total = (bs: SolidEval[]) => bs.reduce((v, b) => v + b.volume!, 0);

/** A 200 × 100 rectangle (closed: four lines sharing corners) on XY. */
async function frame(s: CadSession) {
  const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 200, y: 100 } });
  return sk;
}

describe("weldments", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("mitres a square-tube frame: one body per member, volume = section × centreline", async () => {
    const s = realSession();
    const sk = await frame(s);
    const f = await s.dispatch("feature.member", { sketch: sk, profile: { kind: "square_tube", w: 20, t: 2 } });
    expect(f.ok).toBe(true);
    const bs = members(s);
    expect(bs.length).toBe(4);
    expect(bs.every((b) => b.featureId.startsWith(`${f.createdIds[0]}/`))).toBe(true);
    expect(total(bs)).toBeCloseTo((20 * 20 - 16 * 16) * 600, 4);
    const rows = groupCutList(bs.map((b) => ({ body: b.featureId, ...b.member! })));
    expect(rows.map((r) => [r.profile, r.length, r.angles, r.quantity])).toEqual([
      ["Square tube 20×2", 220, [45, 45], 2],
      ["Square tube 20×2", 120, [45, 45], 2],
    ]);
    expect(cutListCsv(rows).split("\n")[1]).toBe("Square tube 20×2,220,45,45,2");
  });

  it("butt joints keep the volume and square every cut", async () => {
    const s = realSession();
    const sk = await frame(s);
    await s.dispatch("feature.member", { sketch: sk, profile: { kind: "rect_tube", w: 30, h: 20, t: 2 }, corner: "butt" });
    const bs = members(s);
    expect(bs.length).toBe(4);
    expect(total(bs)).toBeCloseTo((30 * 20 - 26 * 16) * 600, 3);
    expect(bs.every((b) => b.member!.angles[0] === 0 && b.member!.angles[1] === 0)).toBe(true);
    // no two members overlap
    const lengths = bs.map((b) => Math.round(b.member!.length * 10) / 10).sort((a, b) => a - b);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(600, 4); // through members gain what the butted ones lose
  });

  it("caps open ends and builds angle sections", async () => {
    const s = realSession();
    const sk = (await s.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
    await s.dispatch("sketch.addLine", { sketch: sk, start: { x: 0, y: 0 }, end: { x: 300, y: 0 } });
    await s.dispatch("feature.member", { sketch: sk, profile: { kind: "angle", w: 50, h: 50, t: 5 }, endCaps: true });
    const [b] = members(s);
    const A = 50 * 5 + 45 * 5;
    expect(b.volume).toBeCloseTo(A * 300 + 2 * A * 5, 4); // the caps are the angle's own outline, 5 thick
    expect(b.member!.profile).toBe("Angle 50×50×5");
  });

  it("adds a gusset body in each corner, clear of the members", async () => {
    const s = realSession();
    const sk = await frame(s);
    const f = await s.dispatch("feature.member", { sketch: sk, profile: { kind: "square_tube", w: 20, t: 2 }, gusset: 50 });
    const bs = members(s);
    const gussets = bs.filter((b) => b.featureId.includes("/gusset"));
    expect(gussets.length).toBe(4);
    for (const g of gussets) {
      expect(g.volume!).toBeGreaterThan(0);
      expect(g.volume!).toBeLessThan(0.5 * 50 * 50 * 2); // the triangle less what the tubes occupy
    }
    // hiding the feature hides every member it made
    await s.setVisibility([f.createdIds[0]], false);
    expect(bs.every((b) => !bodyVisible(s.doc, b))).toBe(true);
  });

  it("follows the layout: editing the sketch moves the members", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "W", expression: "40" });
    const sk = await frame(s);
    await s.dispatch("feature.member", { sketch: sk, profile: { kind: "round_tube", d: "W/2", t: 2 } });
    const v1 = total(members(s));
    const area = Math.PI * (10 * 10 - 8 * 8);
    expect(v1).toBeGreaterThan(area * 500); // mitred round tubes: roughly section × centreline
    await s.dispatch("parameter.set", { name: "W", expression: "60" });
    expect(total(members(s))).toBeGreaterThan(v1 * 1.5);
  });

  it("rejects an impossible profile", async () => {
    const s = realSession();
    const sk = await frame(s);
    await s.dispatch("feature.member", { sketch: sk, profile: { kind: "square_tube", w: 10, t: 6 } });
    const row = evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(Object.values(row).find((r) => r.error)?.error).toMatch(/wall thinner/);
  });

  it("serves the cut list over MCP, with CSV", async () => {
    const { server } = createCadMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    const sk = (await call("sketch__create", { plane: "XY" })).createdIds[0];
    await call("sketch__addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 300, y: 300 } });
    await call("feature__member", { sketch: sk, profile: { kind: "square_tube", w: 25, t: 2 } });
    const list = await call("cut_list", {});
    expect(list.rows).toEqual([{ profile: "Square tube 25×2", length: 325, angles: [45, 45], quantity: 4, bodies: expect.any(Array) }]);
    expect(list.csv).toContain("Square tube 25×2,325,45,45,4");
  });
});
