// A masu box — the traditional origami box — folded from a square sheet, step by step,
// on one `fold` slider: 0 is the flat sheet, 5 the finished box.
//   1  fold the four corners to the centre
//   2  fold the top and bottom edges to the centre
//   3  stand them up: the sides of the box (a collapse: each layer's crease unfolds to 90°)
//   4  raise the ends: each corner folds in on its diagonal as the end comes up (a collapse:
//      the end driven up, the corners solved so the paper stays joined)
//   5  press the corners flat against the sides, inside the box
// The sheet is drawn point up (a diamond), so the box comes out square to the axes. Every line
// is a multiple of q, a quarter of the half-diagonal: the floor is 2q square and the box q tall.
// The paper is white on top and red underneath: the box is red outside, and the corner flaps that line it
// show their red side too.
//   BUILD_ORIGAMI=/abs/out npx vitest run test/masu.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, describeExample, expectCommittedExample } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { sequenceAngles, poseSequence, sequenceClashes, sequencePaper, paperOverlayStray, SheetSequence } from "../src/core/sheetSequence";
import { applyPoint, applyVec, compose } from "../src/math/transform";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_ORIGAMI || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

const STEPS = 5;

async function buildMasu(s: CadSession): Promise<{ sheet: string; lines: Record<string, string> }> {
  for (const [name, val, min, max, step] of [["size", 150, 100, 300, 1], ["fold", STEPS, 0, STEPS, 0.01]] as const) {
    await dis(s, "parameter.add", { name, expression: String(val), min, max, step });
  }
  await dis(s, "parameter.add", { name: "q", expression: "size/sqrt(2)/4", hidden: true });
  const sk = (await dis(s, "sketch.create", { plane: "XY", name: "Sheet" }))[0];
  const at = (x: number, y: number): [string, string] => [`${x}*q`, `${y}*q`];
  const corners: string[] = [];
  for (const [x, y] of [[4, 0], [0, 4], [-4, 0], [0, -4]]) corners.push((await dis(s, "sketch.addPoint", { sketch: sk, x: at(x, y)[0], y: at(x, y)[1] }))[0]);
  for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: corners[i] }, end: { ref: corners[(i + 1) % 4] } });
  const lines: Record<string, string> = {};
  const line = async (name: string, a: [number, number], b: [number, number]) => {
    const [ax, ay] = at(...a), [bx, by] = at(...b);
    lines[name] = (await dis(s, "sketch.addLine", { sketch: sk, start: { x: ax, y: ay }, end: { x: bx, y: by }, construction: true }))[0];
  };
  // 1: the corners to the centre
  await line("cornerR", [2, -2], [2, 2]); await line("cornerT", [2, 2], [-2, 2]);
  await line("cornerL", [-2, 2], [-2, -2]); await line("cornerB", [-2, -2], [2, -2]);
  // 2: the top and bottom edges to the centre (through the corners folded in)
  await line("sideT", [-3, 1], [3, 1]); await line("sideB", [3, -1], [-3, -1]);
  // 3: stood up — the same creases, on the sheet and on the flaps folded with it
  for (const [k, y] of [["T", 1], ["B", -1]] as const) {
    await line(`wall${k}`, [-2, y], [2, y]);
    await line(`lining${k}`, [-1, 3 * y], [1, 3 * y]);
    await line(`wall${k}R`, [2, y], [3, y]); await line(`wall${k}L`, [-3, y], [-2, y]);
  }
  // 4, 5: each end and its two corners
  for (const [k, x] of [["R", 1], ["L", -1]] as const) {
    await line(`end${k}`, [x, -1], [x, 1]);           // the end wall's foot
    await line(`endLining${k}`, [3 * x, -1], [3 * x, 1]); // the end's corner flap, where it meets the floor
    for (const [c, y] of [["T", 1], ["B", -1]] as const) {
      await line(`side${k}${c}`, [x, y], [x, 2 * y]);          // the corner square's edge on the side wall
      await line(`sideLining${k}${c}`, [x, 2 * y], [x, 3 * y]); // ... on the side's flap stacked on it
      await line(`diag${k}${c}`, [x, y], [2 * x, 2 * y]);      // the corner square's diagonal
      await line(`foot${k}${c}`, [x, y], [2 * x, y]);          // its edge on the end wall
      await line(`footLining${k}${c}`, [2 * x, y], [3 * x, y]); // ... on the end's flap stacked on it
    }
  }
  const L = lines;
  const folds: Record<string, unknown>[] = [];
  for (const k of ["cornerR", "cornerT", "cornerL", "cornerB"]) folds.push({ line: L[k], step: 1, angle: 180 });
  folds.push({ line: L.sideT, step: 2, angle: 180 }, { line: L.sideB, step: 2, angle: 180 });
  for (const k of ["T", "B"]) {
    folds.push({ line: L[`wall${k}`], step: 3, angle: 90, collapse: true });
    for (const t of [`lining${k}`, `wall${k}R`, `wall${k}L`]) folds.push({ line: L[t], step: 3, collapse: true, with: L[`wall${k}`] });
  }
  for (const k of ["R", "L"]) {
    folds.push({ line: L[`end${k}`], step: 4, angle: 90, collapse: true }, { line: L[`endLining${k}`], step: 4, collapse: true, with: L[`end${k}`] });
    for (const c of ["T", "B"]) {
      const id = `${k}${c}`;
      folds.push(
        { line: L[`side${id}`], step: 4, collapse: true, direction: "valley" }, // the corner folds in
        { line: L[`sideLining${id}`], step: 4, collapse: true, with: L[`side${id}`] },
        { line: L[`diag${id}`], step: 4, collapse: true, direction: "valley" },
        { line: L[`foot${id}`], step: 4, collapse: true },
        { line: L[`footLining${id}`], step: 4, collapse: true, with: L[`foot${id}`] },
        // 5: flat against the side
        { line: L[`side${id}`], step: 5, angle: 180, collapse: true },
        { line: L[`sideLining${id}`], step: 5, collapse: true, with: L[`side${id}`] },
        { line: L[`foot${id}`], step: 5, collapse: true },
        { line: L[`footLining${id}`], step: 5, collapse: true, with: L[`foot${id}`] },
      );
    }
  }
  const sheet = (await dis(s, "feature.sheet", {
    sketch: sk, name: "Masu box", thickness: 0.1, radius: 0,
    fixed: { x: 5, y: 3 }, // held by the floor
    progress: "fold",
    folds,
  }))[0];
  // white on top, red underneath: the outside, and the flaps that line it
  const mat = (await dis(s, "material.create", { name: "Origami paper", kind: "paper", color: "#f4f1ea", backColor: "#b33a2e" }))[0];
  await dis(s, "material.assign", { material: mat });
  const hid = await s.setHidden([sk]);
  if (!hid.ok) throw new Error(`hide: ${hid.error}`);
  await describeExample(s, { title: "Masu box", description: "The traditional origami box, folded from one square sheet: corners in, sides up, then the ends, the corners tucking in as they rise." }, {
    size: { label: "Paper size", unit: "mm", description: "The square's side; 150 mm is standard origami paper. The box is a quarter as wide." },
    fold: { label: "Fold", unit: "of 5", description: "0 is the flat sheet; 5 the finished box" },
  });
  return { sheet, lines };
}

function evaluate(s: CadSession, overrides: Record<string, number> = {}): Record<string, SolidEval> {
  const scope = { ...resolveParameters(s.doc.parameters).scope, ...overrides };
  return evaluateFeatures(s.doc, scope);
}

/** Where a flat point of the sheet is (world), the sheet posed at `progress`. */
function placeOf(seq: SheetSequence, frame: Parameters<typeof compose>[0], progress: number) {
  const T = poseSequence(seq, sequenceAngles(seq, progress));
  const facetOf = (p: { x: number; y: number }) => seq.facets.findIndex((f) => f.poly.every((a, i) => {
    const b = f.poly[(i + 1) % f.poly.length];
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-6;
  }));
  return {
    at(x: number, y: number) { const k = facetOf({ x, y }); expect(k, `(${x}, ${y}) on the sheet`).toBeGreaterThanOrEqual(0); return applyPoint(compose(frame, T[k]), { x, y, z: 0 }); },
    normal(x: number, y: number) { const k = facetOf({ x, y }); return applyVec(compose(frame, T[k]), { x: 0, y: 0, z: 1 }); },
  };
}

/** The widest a crease opens anywhere along the fold (the paper is rigid between creases, its layers a gap apart). */
function widestJoin(seq: SheetSequence, per: number): number {
  let worst = 0;
  for (let k = 0; k <= seq.steps * per; k++) {
    const T = poseSequence(seq, sequenceAngles(seq, k / per));
    for (const c of seq.creases) for (const q of [c.a, c.b]) {
      const a = applyPoint(T[c.facets[0]], { ...q, z: 0 }), b = applyPoint(T[c.facets[1]], { ...q, z: 0 });
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
  }
  return worst;
}

describe("origami: a masu box folded step by step", () => {
  let s: CadSession;
  let ids: { sheet: string; lines: Record<string, string> };
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    ids = await buildMasu(s);
    await s.recompute();
  }, 120000);

  it("builds the finished box from one square of paper", async () => {
    if (OUT) writeFileSync(`${OUT}/masu.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "masu");
    for (const sk of Object.values(s.doc.sketches)) expect(sk.status.conflicting, `sketch ${sk.name}`).toBe(false);
    const out = evaluate(s);
    for (const r of Object.values(out)) expect(r.error, r.name).toBeUndefined();
    const b = out[ids.sheet];
    expect(b.surface).toBe(true);
    expect(b.area).toBeCloseTo(150 * 150, 3); // folding keeps the paper
    const seq = b.sheet!.sequence!;
    expect(seq.plan.steps).toBe(STEPS);
    expect(seq.plan.collapses?.map((c) => c.step)).toEqual([3, 4, 5]);
  }, 120000);

  it("is a box when done: a square floor, four walls straight up, lined inside", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!;
    const P = placeOf(seq.plan, seq.frame, STEPS);
    const q = 150 / Math.SQRT2 / 4, tol = 1;
    // the floor stays put; the walls stand a quarter-width tall round it, their tops level
    const floor = P.at(0.3 * q, 0.2 * q);
    expect(floor.z).toBeCloseTo(0, 6);
    for (const [x, y, wx, wy] of [[1.5, 0, 1, 0], [-1.5, 0, -1, 0], [0, 1.5, 0, 1], [0, -1.5, 0, -1]]) {
      const p = P.at(x * q, y * q), n = P.normal(x * q, y * q), top = P.at(x * q * 1.999 / 1.5, y * q * 1.999 / 1.5);
      expect(Math.abs(n.z), `wall at (${x}, ${y}) stands up`).toBeLessThan(1e-3);
      expect(Math.abs(n.x * wx + n.y * wy), `... square to the axis`).toBeCloseTo(1, 3);
      expect(p.x * wx + p.y * wy, `... at the floor's edge`).toBeCloseTo(q, 0);
      expect(p.z).toBeCloseTo(0.5 * q, 0);
      expect(top.z, `... a quarter-width tall`).toBeCloseTo(q, 0);
    }
    // the corner flaps line the walls inside and reach the floor's centre
    for (const [x, y] of [[3.99, 0], [-3.99, 0], [0, 3.99], [0, -3.99]]) {
      const tip = P.at(x * q, y * q);
      expect(Math.hypot(tip.x, tip.y), `tip (${x}, ${y}) at the centre`).toBeLessThan(tol);
      expect(tip.z).toBeLessThan(1);
    }
    // the corners are tucked in: every corner square lies inside the box, flat against a side
    for (const [x, y] of [[1.5, 1.4], [-1.5, 1.4], [1.5, -1.4], [-1.5, -1.4]]) {
      const c = P.at(x * q, y * q);
      expect(Math.abs(c.x)).toBeLessThan(q + tol);
      expect(Math.abs(c.y)).toBeLessThan(q + tol);
      expect(Math.abs(P.normal(x * q, y * q).y)).toBeCloseTo(1, 3);
    }
    // outside the colour (the paper's underside), inside the white
    expect(P.normal(1.5 * q, 0).x).toBeLessThan(-0.99); // the right wall's top faces in
  });

  it("keeps its drawn bends and crease marks on the paper at every end of a step and all through the folds (0.02 of a step at a time)", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!, bend = seq.bend ?? 0.4;
    let worst = 0, at = 0;
    for (let k = 0; k <= STEPS * 50; k++) {
      const angles = sequenceAngles(seq.plan, k / 50), p = sequencePaper(seq.plan, angles, seq.frame, { radius: bend });
      const d = paperOverlayStray(seq.plan, angles, seq.frame, p, bend);
      if (d > worst) { worst = d; at = k / 50; }
    }
    expect(worst, `at fold ${at}`).toBe(0);
  }, 120000);

  it("never passes through itself, and its creases stay joined, from flat to finished", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!.plan;
    const hits: string[] = [];
    for (let k = 0; k <= STEPS * 40; k++) {
      const p = k / 40;
      // (a corner's two halves close on their shared diagonal: within ¾ mm of it they touch as they come together)
      const c = sequenceClashes(seq, sequenceAngles(seq, p), 0.75);
      if (c.length) hits.push(`fold ${p}: facets ${c.map(([a, b]) => `${a}×${b}`).join(", ")}`);
    }
    expect(hits).toEqual([]);
    expect(widestJoin(seq, 20)).toBeLessThan(1); // under a millimetre (the layers' own spacing)
  });

  it("folds part-way through each step, and lies flat at 0", () => {
    const at = (fold: number) => { const r = evaluate(s, { fold })[ids.sheet]; expect(r.error).toBeUndefined(); return r; };
    const flat = at(0);
    expect(flat.bounds!.min.z).toBeCloseTo(0, 6);
    expect(flat.bounds!.max.z).toBeCloseTo(0, 6);
    const half = 150 / Math.SQRT2;
    expect([flat.bounds!.min.x, flat.bounds!.max.x, flat.bounds!.min.y, flat.bounds!.max.y]).toEqual([-half, half, -half, half].map((v) => expect.closeTo(v, 4)));
    expect(at(1).bounds!.max.x).toBeCloseTo(half / 2, 3);  // the corners in: half as wide
    expect(at(2).bounds!.max.y).toBeLessThan(half / 4 + 1); // the sides in to the centre line... (their edges at q)
    expect(at(3).bounds!.max.z).toBeCloseTo(half / 4, 0);  // the sides stood up
    const done = at(5);
    expect(done.bounds!.max.x - done.bounds!.min.x).toBeLessThan(half / 2 + 2);
    expect(done.bounds!.max.z).toBeCloseTo(half / 4, 0);
    for (const fold of [0.5, 1.5, 2.5, 3.5, 4.5]) at(fold);
  }, 120000);

  it("folds at every size the slider allows", async () => {
    for (const size of [100, 300]) {
      await dis(s, "parameter.set", { name: "size", expression: String(size) });
      const b = evaluate(s)[ids.sheet];
      expect(b.error, `${size}`).toBeUndefined();
      expect(b.area).toBeCloseTo(size * size, 2);
      const seq = b.sheet!.sequence!.plan;
      for (const p of [2.5, 3.5, 4.5, 5]) expect(sequenceClashes(seq, sequenceAngles(seq, p), 0.75), `${size} at fold ${p}`).toEqual([]);
    }
    await dis(s, "parameter.set", { name: "size", expression: "150" });
  }, 120000);
});
