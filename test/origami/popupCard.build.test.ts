// A pop-up greeting card with three mechanisms cut and creased into one sheet, all rising on one `open` slider
// (0 closed flat … 180 open flat):
//   - a two-stage box (a layered pop-up): a parallel fold stepping up off the card, with a second, smaller box cut
//     into its riser, a step within the step;
//   - a figure standing on a floating layer: a flap cut (a U of slits) into the top of a box, hinged on a crease
//     parallel to the spine, that rises as the card opens and lies flat in its box when it closes;
//   - a plain box fold near the head of the card.
// Every mechanism is rigid origami (core/sheet.ts planFold): the spine and the creases that fold as far as it (a
// box's three) are driven by `open`, the figure's hinge from 40° open; the paper is cut only along the slits. (A
// v-fold "mouth" — a slit across the spine with a diamond of creases round it — was tried too: rigidly it has a
// trivial branch where its lips stay flat and the spine inside just folds with the card, and the planner's solver
// takes that one; real paper is pushed through. It's left out until a lip's angle can be driven.) Checked as it opens and closes: no piece passes through
// another or leaves the card, it lies flat at both ends, and the closed card's stack is one paper can make
// (core/sheetLayers.ts). The crease pattern (cuts and folds) prints at true size from the app.
//   BUILD_POPUP=/abs/out npx vitest run test/popupCard.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, describeExample, expectCommittedExample } from "../helpers";
import { initKernel } from "../../src/core/occ/kernel";
import { serializeDocument } from "../../src/core/persistence";
import { evaluateFeatures, SolidEval } from "../../src/core/features";
import { resolveParameters } from "../../src/core/parameters";
import { panelClashes } from "../../src/core/sheetSequence";
import { checkPanelLayers, panelOutline } from "../../src/core/sheetLayers";
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

/** The card: width W (the spine at W/2), height H. The mouth sits at 0.8 H, the two-stage box at 0.5 H, the plain
 *  box at 0.2 H; `reach` is the big box's reach either side of the spine, the others scale from it. */
export async function buildPopupCard(s: CadSession): Promise<{ sheet: string }> {
  for (const [name, val, min, max, step] of [["open", 90, 0, 180, 1], ["width", 180, 120, 300, 1], ["height", 130, 90, 200, 1], ["reach", 20, 8, 40, 1]] as const) {
    await dis(s, "parameter.add", { name, expression: String(val), min, max, step });
  }
  const sk = (await dis(s, "sketch.create", { plane: "XY", name: "Card" }))[0];
  const corners: string[] = [];
  for (const [x, y] of [["0", "0"], ["width", "0"], ["width", "height"], ["0", "height"]]) corners.push((await dis(s, "sketch.addPoint", { sketch: sk, x, y }))[0]);
  for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: corners[i] }, end: { ref: corners[(i + 1) % 4] } });
  const line = async (a: [string, string], b: [string, string]) => (await dis(s, "sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true }))[0];
  const X = "width/2";
  const cuts: string[] = [], folds: Record<string, unknown>[] = [];
  // --- the head box at 0.8 H (reach·0.75, span reach/2), with a figure standing on its top: a flap cut by a U of
  // slits, hinged at its foot on a crease parallel to the spine, that rises as the card opens (from 40° open; square at 180°)
  const my = "height*0.8", mr = "reach*0.75", ms = "reach/4";
  cuts.push(await line([`${X}-${mr}`, `${my}-${ms}`], [`${X}+${mr}`, `${my}-${ms}`]), await line([`${X}-${mr}`, `${my}+${ms}`], [`${X}+${mr}`, `${my}+${ms}`]));
  folds.push({ line: await line([`${X}-${mr}`, `${my}-${ms}`], [`${X}-${mr}`, `${my}+${ms}`]), angle: "180-open" });
  folds.push({ line: await line([`${X}+${mr}`, `${my}-${ms}`], [`${X}+${mr}`, `${my}+${ms}`]), angle: "180-open" });
  folds.push({ line: await line([X, `${my}-${ms}`], [X, `${my}+${ms}`]), angle: "-(180-open)" });
  const fx0 = `${X}+reach*0.15`, fx1 = `${X}+reach*0.6`, fy = "reach*0.15";
  cuts.push(await line([fx0, `${my}-${fy}`], [fx1, `${my}-${fy}`]), await line([fx0, `${my}+${fy}`], [fx1, `${my}+${fy}`]), await line([fx1, `${my}-${fy}`], [fx1, `${my}+${fy}`]));
  folds.push({ line: await line([fx0, `${my}-${fy}`], [fx0, `${my}+${fy}`]), angle: "max(0, open-40)*90/140" }); // lying flat in its box until the card is well open (the closing half would press it flat)
  // --- the two-stage box at 0.5 H: the big box (reach, span reach), a smaller one (reach/2, span reach/2) on its riser
  const by = "height*0.5", bs = "reach/2";
  cuts.push(await line([`${X}-reach`, `${by}-${bs}`], [`${X}+reach`, `${by}-${bs}`]), await line([`${X}-reach`, `${by}+${bs}`], [`${X}+reach`, `${by}+${bs}`]));
  // (a box's three creases fold as far as the spine does — driven, so two boxes stacked take their own steps)
  folds.push({ line: await line([`${X}-reach`, `${by}-${bs}`], [`${X}-reach`, `${by}+${bs}`]), angle: "180-open" });
  folds.push({ line: await line([`${X}+reach`, `${by}-${bs}`], [`${X}+reach`, `${by}+${bs}`]), angle: "180-open" });
  const ss = "reach/4", sr = "reach/2";
  cuts.push(await line([`${X}-${sr}`, `${by}-${ss}`], [`${X}+${sr}`, `${by}-${ss}`]), await line([`${X}-${sr}`, `${by}+${ss}`], [`${X}+${sr}`, `${by}+${ss}`]));
  // (the small box's creases are signed the other way round: it steps in off the big box's riser, a step within the step)
  folds.push({ line: await line([`${X}-${sr}`, `${by}-${ss}`], [`${X}-${sr}`, `${by}+${ss}`]), angle: "-(180-open)" });
  folds.push({ line: await line([`${X}+${sr}`, `${by}-${ss}`], [`${X}+${sr}`, `${by}+${ss}`]), angle: "-(180-open)" });
  // the big box's middle crease, in two pieces either side of the small box's slits, and the small box's middle
  folds.push({ line: await line([X, `${by}-${bs}`], [X, `${by}-${ss}`]), angle: "-(180-open)" });
  folds.push({ line: await line([X, `${by}+${ss}`], [X, `${by}+${bs}`]), angle: "-(180-open)" });
  folds.push({ line: await line([X, `${by}-${ss}`], [X, `${by}+${ss}`]), angle: "180-open" });
  // --- the plain box at 0.2 H (reach·0.75, span reach/2)
  const py = "height*0.2", pr = "reach*0.75", ps = "reach/4", mh = ms;
  cuts.push(await line([`${X}-${pr}`, `${py}-${ps}`], [`${X}+${pr}`, `${py}-${ps}`]), await line([`${X}-${pr}`, `${py}+${ps}`], [`${X}+${pr}`, `${py}+${ps}`]));
  folds.push({ line: await line([`${X}-${pr}`, `${py}-${ps}`], [`${X}-${pr}`, `${py}+${ps}`]), angle: "180-open" });
  folds.push({ line: await line([`${X}+${pr}`, `${py}-${ps}`], [`${X}+${pr}`, `${py}+${ps}`]), angle: "180-open" });
  folds.push({ line: await line([X, `${py}-${ps}`], [X, `${py}+${ps}`]), angle: "-(180-open)" });
  // --- the spine, in the stretches between the mechanisms, driven by `open`
  for (const [a, b] of [["0", `${py}-${ps}`], [`${py}+${ps}`, `${by}-${bs}`], [`${by}+${bs}`, `${my}-${mh}`], [`${my}+${mh}`, "height"]]) folds.push({ line: await line([X, a], [X, b]), angle: "180-open" });
  const sheet = (await dis(s, "feature.sheet", {
    sketch: sk, name: "Card", thickness: 0, radius: 0,
    fixed: { x: 20, y: 20 }, // held by the left half
    cuts, folds,
  }))[0];
  const mat = (await dis(s, "material.create", { name: "Card stock", kind: "paper", color: "#f7f3e8", backColor: "#b8402f" }))[0];
  await dis(s, "material.assign", { material: mat });
  const hid = await s.setHidden([sk]);
  if (!hid.ok) throw new Error(`hide: ${hid.error}`);
  await describeExample(s, { title: "Pop-up greeting card", description: "Three pop-up mechanisms cut and creased into one card, rising together as it opens: a box with a figure standing on its top, a two-stage box (a step within a step), and a box fold at the foot. Closed, it all folds flat inside." }, {
    open: { label: "Open", unit: "°", description: "0 is the card closed flat; 180 fully open" },
    width: { label: "Card width", unit: "mm", description: "The card open flat; the spine is at half" },
    height: { label: "Card height", unit: "mm" },
    reach: { label: "Pop-up reach", unit: "mm", description: "How far the big box reaches either side of the spine; the other boxes and the figure scale with it" },
  });
  return { sheet };
}

function evaluate(s: CadSession, overrides: Record<string, number> = {}): Record<string, SolidEval> {
  const scope = { ...resolveParameters(s.doc.parameters).scope, ...overrides };
  return evaluateFeatures(s.doc, scope);
}

describe("pop-up greeting card: three mechanisms on one sheet", () => {
  let s: CadSession;
  let ids: { sheet: string };
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    ids = await buildPopupCard(s);
    await s.recompute();
  }, 120000);

  it("builds: one sheet, eleven slits, its panels placed by the spine's opening", async () => {
    if (OUT) writeFileSync(`${OUT}/popup-card.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "popup-card");
    const out = evaluate(s);
    for (const r of Object.values(out)) expect(r.error, r.name).toBeUndefined();
    const b = out[ids.sheet];
    expect(b.sheet!.flat.cuts?.length).toBe(11);
    expect(b.sheet!.panels!.length).toBe(2 + 2 + 1 + 2 + 2 + 2); // the halves, the head box's panels and its figure, two boxes' panels, the small box's
  });

  it("at 90° every mechanism stands off the card: the boxes step up, the small box inside the big one, the figure leaning up", () => {
    const b = evaluate(s, { open: 90 })[ids.sheet];
    const panels = b.sheet!.panels!;
    const at = (x: number, y: number) => { const k = panels.findIndex((p) => insideSegs({ x, y }, p.segs)); expect(k, `(${x}, ${y})`).toBeGreaterThanOrEqual(0); return { p: applyPoint(panels[k].T, { x, y, z: 0 }), n: panels[k].T.z }; };
    const W = 180, H = 130, R = 20;
    expect(Math.abs(at(20, 20).n.z)).toBeCloseTo(1, 6); // the left half level
    expect(Math.abs(at(W - 20, 20).n.z)).toBeLessThan(1e-6); // the right half square to it
    // the head box's top: level, 0.75 of a reach up; the figure on it at 32° (50° of opening past 40°, over 140°)
    const head = at(W / 2 + R * 0.7, H * 0.8 + R * 0.2), figure = at(W / 2 + R * 0.4, H * 0.8);
    expect(Math.abs(head.n.z)).toBeCloseTo(1, 6); expect(head.p.z).toBeCloseTo(R * 0.75, 6);
    expect(Math.abs(figure.n.z)).toBeCloseTo(Math.cos((50 * 90 / 140) * Math.PI / 180), 6); expect(figure.p.z).toBeGreaterThan(R * 0.75 + 1);
    // the big box's far panel: level, a reach up; the small box's: level, half a reach up, inside the big one
    const big = at(W / 2 + R * 0.8, H * 0.5 + R * 0.4), small = at(W / 2 - R * 0.3, H * 0.5);
    expect(Math.abs(big.n.z)).toBeCloseTo(1, 6); expect(big.p.z).toBeCloseTo(R, 6);
    expect(Math.abs(small.n.z)).toBeCloseTo(1, 6); expect(small.p.z).toBeCloseTo(R / 2, 6);
    expect(small.p.x).toBeGreaterThan(W / 2 - R); expect(small.p.x).toBeLessThan(W / 2);
    // the foot box: level, 0.75 of a reach up
    const foot = at(W / 2 + R * 0.5, H * 0.2);
    expect(Math.abs(foot.n.z)).toBeCloseTo(1, 6); expect(foot.p.z).toBeCloseTo(R * 0.75, 6);
  });

  it("opens and closes with no piece through another or past the card's edge, flat at both ends, a stack when closed", () => {
    const hits: string[] = [];
    for (let open = 1; open <= 179; open += 3) {
      const b = evaluate(s, { open })[ids.sheet];
      expect(b.error, `open ${open}`).toBeUndefined();
      const c = panelClashes(b.sheet!.panels!, 0.5);
      if (c.length) hits.push(`open ${open}: ${c.map(([i, j]) => `${i}-${j}`).join(" ")}`);
      // inside the card: nothing beyond the halves' outline (x within the left half's reach, y within the height)
      for (const p of b.sheet!.panels!) for (const q of panelOutline(p.segs)) { const w = applyPoint(p.T, { ...q, z: 0 }); expect(w.y).toBeGreaterThanOrEqual(-1e-6); expect(w.y).toBeLessThanOrEqual(130 + 1e-6); expect(w.x).toBeGreaterThanOrEqual(-1e-6); }
    }
    expect(hits).toEqual([]);
    // flat at both ends — but for the figure, standing square on its box when the card lies open
    for (const open of [0, 180]) for (const p of evaluate(s, { open })[ids.sheet].sheet!.panels!) {
      const figure = insideSegs({ x: 180 / 2 + 20 * 0.4, y: 130 * 0.8 }, p.segs);
      expect(Math.abs(p.T.z.z)).toBeCloseTo(open === 180 && figure ? 0 : 1, 6);
    }
    expect(checkPanelLayers(evaluate(s, { open: 2 })[ids.sheet].sheet!.panels!, 0.1, "closed")).toEqual([]); // (nearly closed: at 0.5° the paper, no thickness, is within a hair of coinciding)
  }, 180000);

  it("builds at every size the sliders allow", () => {
    for (const o of [{ width: 120, height: 90, reach: 8 }, { width: 300, height: 200, reach: 40 }, { width: 120, height: 200, reach: 40 }]) {
      for (const open of [0, 60, 180]) {
        const b = evaluate(s, { ...o, open })[ids.sheet];
        expect(b.error, JSON.stringify({ ...o, open })).toBeUndefined();
        if (open > 0 && open < 180) expect(panelClashes(b.sheet!.panels!, 0.5)).toEqual([]);
      }
    }
  }, 120000);
});
