// A pop-up card with a parallel (box) fold: a card folded in half, two slits across the spine, and the strip
// between them creased so it steps up off the card as it opens. One `open` slider runs it: 0 is the card closed
// flat, 180 fully open and flat. The mechanism is rigid origami (core/sheet.ts planFold): the spine is driven by
// `open`, the box's three creases are solved so every panel stays joined, and the paper is cut only along the
// slits. The same sheet machinery checks the closed card's stack (core/sheetLayers.ts) and that no panel passes
// through another as it opens and closes.
//   BUILD_POPUP=/abs/out npx vitest run test/popupBox.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, describeExample, expectCommittedExample } from "../helpers";
import { initKernel } from "../../src/core/occ/kernel";
import { serializeDocument } from "../../src/core/persistence";
import { evaluateFeatures, SolidEval } from "../../src/core/features";
import { resolveParameters } from "../../src/core/parameters";
import { panelClashes } from "../../src/core/sheetSequence";
import { checkPanelLayers } from "../../src/core/sheetLayers";
import { insideSegs } from "../../src/core/sheet";
import { applyPoint } from "../../src/math/transform";
import type { CadSession } from "../../src/core/command/session";

const OUT = process.env.BUILD_POPUP || "";
const wasm = readFileSync(fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

/** The card: width W (the spine at W/2), height H; the box `reach` either side of the spine, `span` tall. */
export async function buildPopupBox(s: CadSession): Promise<{ sheet: string }> {
  for (const [name, val, min, max, step] of [["open", 90, 0, 180, 1], ["width", 150, 100, 300, 1], ["height", 100, 60, 200, 1], ["reach", 15, 5, 40, 1], ["span", 20, 10, 60, 1]] as const) {
    await dis(s, "parameter.add", { name, expression: String(val), min, max, step });
  }
  const sk = (await dis(s, "sketch.create", { plane: "XY", name: "Card" }))[0];
  const corners: string[] = [];
  for (const [x, y] of [["0", "0"], ["width", "0"], ["width", "height"], ["0", "height"]]) corners.push((await dis(s, "sketch.addPoint", { sketch: sk, x, y }))[0]);
  for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: corners[i] }, end: { ref: corners[(i + 1) % 4] } });
  const line = async (a: [string, string], b: [string, string]) => (await dis(s, "sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true }))[0];
  // the slits, across the spine
  const cutLo = await line(["width/2-reach", "height/2-span/2"], ["width/2+reach", "height/2-span/2"]);
  const cutHi = await line(["width/2-reach", "height/2+span/2"], ["width/2+reach", "height/2+span/2"]);
  // the spine, below and above the box
  const spine1 = await line(["width/2", "0"], ["width/2", "height/2-span/2"]);
  const spine2 = await line(["width/2", "height/2+span/2"], ["width/2", "height"]);
  // the box: its two outer creases, and its middle one on the spine's line
  const boxL = await line(["width/2-reach", "height/2-span/2"], ["width/2-reach", "height/2+span/2"]);
  const boxM = await line(["width/2", "height/2-span/2"], ["width/2", "height/2+span/2"]);
  const boxR = await line(["width/2+reach", "height/2-span/2"], ["width/2+reach", "height/2+span/2"]);
  const sheet = (await dis(s, "feature.sheet", {
    sketch: sk, name: "Card", thickness: 0, radius: 0,
    fixed: { x: 30, y: 20 }, // held by the left half
    cuts: [cutLo, cutHi],
    folds: [
      { line: spine1, angle: "180-open" }, { line: spine2, angle: "180-open" },
      { line: boxL, direction: "valley" }, { line: boxM, direction: "mountain" }, { line: boxR, direction: "valley" },
    ],
  }))[0];
  const mat = (await dis(s, "material.create", { name: "Card stock", kind: "paper", color: "#f7f3e8", backColor: "#2f6fb3" }))[0];
  await dis(s, "material.assign", { material: mat });
  const hid = await s.setHidden([sk]);
  if (!hid.ok) throw new Error(`hide: ${hid.error}`);
  await describeExample(s, { title: "Pop-up card: box fold", description: "A card folded in half with a parallel (box) fold cut into it: two slits across the spine, the strip between creased so it steps up as the card opens, and folds flat inside when it closes." }, {
    open: { label: "Open", unit: "°", description: "0 is the card closed flat; 180 fully open" },
    width: { label: "Card width", unit: "mm", description: "The card open flat; the spine is at half" },
    height: { label: "Card height", unit: "mm" },
    reach: { label: "Box reach", unit: "mm", description: "How far the box's slits reach either side of the spine" },
    span: { label: "Box span", unit: "mm", description: "The box's height along the spine (between the slits)" },
  });
  return { sheet };
}

function evaluate(s: CadSession, overrides: Record<string, number> = {}): Record<string, SolidEval> {
  const scope = { ...resolveParameters(s.doc.parameters).scope, ...overrides };
  return evaluateFeatures(s.doc, scope);
}

describe("pop-up card: a box fold", () => {
  let s: CadSession;
  let ids: { sheet: string };
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    ids = await buildPopupBox(s);
    await s.recompute();
  }, 120000);

  it("builds: one sheet with two slits, its panels placed by the spine's opening", async () => {
    if (OUT) writeFileSync(`${OUT}/popup-box.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "popup-box");
    const out = evaluate(s);
    for (const r of Object.values(out)) expect(r.error, r.name).toBeUndefined();
    const b = out[ids.sheet];
    expect(b.sheet!.panels!.length).toBe(4); // the two halves, the box's two panels
    expect(b.sheet!.flat.cuts?.length).toBe(2);
  });

  it("at 90° the box is a step: its far panel level, a reach up off the card, square to the halves", () => {
    const b = evaluate(s, { open: 90 })[ids.sheet];
    const panels = b.sheet!.panels!;
    const at = (x: number, y: number) => { const k = panels.findIndex((p) => insideSegs({ x, y }, p.segs)); expect(k).toBeGreaterThanOrEqual(0); return { p: applyPoint(panels[k].T, { x, y, z: 0 }), n: panels[k].T.z }; };
    const left = at(30, 20), right = at(120, 20), near = at(68, 50), far = at(82, 50);
    expect(Math.abs(left.n.z)).toBeCloseTo(1, 6);
    expect(Math.abs(right.n.z)).toBeLessThan(1e-6); // the right half stands square
    expect(Math.abs(near.n.z)).toBeLessThan(1e-6); // the box's near panel rises square off the left half
    expect(Math.abs(far.n.z)).toBeCloseTo(1, 6); // its far panel level, 15 up
    expect(far.p.z).toBeCloseTo(15, 6);
  });

  it("opens and closes without any panel passing through another, and lies flat at both ends", () => {
    const hits: string[] = [];
    for (let open = 1; open <= 179; open += 4) {
      const b = evaluate(s, { open })[ids.sheet];
      expect(b.error, `open ${open}`).toBeUndefined();
      const c = panelClashes(b.sheet!.panels!, 0.5);
      if (c.length) hits.push(`open ${open}: ${c.length}`);
    }
    expect(hits).toEqual([]);
    for (const open of [0, 180]) {
      const b = evaluate(s, { open })[ids.sheet];
      for (const p of b.sheet!.panels!) expect(Math.abs(p.T.z.z)).toBeCloseTo(1, 6);
    }
    // nearly closed: the stack it folds into is one paper can make (the box's panels between the halves)
    const closed = evaluate(s, { open: 0.5 })[ids.sheet];
    expect(checkPanelLayers(closed.sheet!.panels!, 0.1, "closed")).toEqual([]);
  }, 120000);

  it("builds at every size the sliders allow", () => {
    for (const o of [{ width: 100, height: 60, reach: 5, span: 10 }, { width: 300, height: 200, reach: 40, span: 60 }]) {
      const b = evaluate(s, { ...o, open: 60 })[ids.sheet];
      expect(b.error, JSON.stringify(o)).toBeUndefined();
      expect(panelClashes(b.sheet!.panels!, 0.5)).toEqual([]);
    }
  });
});
