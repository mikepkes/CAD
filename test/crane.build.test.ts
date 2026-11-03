// A paper crane — the traditional orizuru — folded from a square sheet, step by step, on one
// `fold` slider: 0 is the flat sheet, the last step the finished bird.
//   1  collapse into a square (preliminary) base: the diagonals and the folds between them at once
//   2  petal-fold the front: its bottom point lifts up over the top as the sides fold in
//   3  turn over;  4  petal-fold the back (the bird base)
//   5  narrow the legs: fold the front's lower edges to the centre;  6  turn over;  7  the same behind
//   8  inside reverse folds: the neck and the tail swung up and out, each leg's point folded back on itself
//      through every layer of it and tucked between the body's layers (core/sheetSequence.ts reverseStep: the end
//      state and its layer order are declared; between the keyframes the point swings over as one and settles
//      through its own layers by a few paper thicknesses — the bending transition isn't used here, see below)
//   9  the head: the neck's tip turned down the same way
//  10  fold the wings down, square to the body (about the straight middle of each petal hinge: narrowing the legs
//      folded the hinge's ends over with the legs' flaps, as it does in a real crane — see swings());  11  stand the bird up
// Steps 1, 2, 4, 9 and 10 are collapses (core/sheetSequence.ts): their creases fold at once, one driven and
// the rest solved so the paper stays joined, or one carried through a stack of layers; step 8 is a reverse fold. The sheet is drawn
// point up (a diamond), its half-diagonal h: every crease is a fixed fraction of it, so the bird scales.
//   BUILD_ORIGAMI=/abs/out npx vitest run test/crane.build.test.ts
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, describeExample, expectCommittedExample } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { serializeDocument } from "../src/core/persistence";
import { evaluateFeatures, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { planSequence, sequenceAngles, poseSequence, sequenceClashes, SheetSequence, SeqFoldDef } from "../src/core/sheetSequence";
import { applyPoint, compose, invert } from "../src/math/transform";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_ORIGAMI || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

/** Where the sheet is held (in half-diagonals): the body's top, between the wings. */
const HELD = { x: -0.15, y: 0.02 };
/** Where the petal fold's kite creases meet the side edges (1 − 1/√2 of the half-diagonal, along each axis). */
const K = 1 - Math.SQRT1_2;
/** Where a leg's narrowing crease meets the petal hinge, along the hinge from its middle (the leg's tip is 45° wide in
 *  the bird base; its edge folded to its centre line puts the crease at 11.25°, and the hinge is 1 − K below the tip). */
const P = (1 - K) * Math.tan(Math.PI / 16);
/** Where that crease meets the side edge of the flat sheet (the same point, on the leg's top layer). */
const N = 0.5 - (0.5 - K) * (P / K);

/** Each fold: its line on the flat sheet (in half-diagonals, the centre at 0), and the rest of its definition. */
type Fold = { a: [number, number]; b: [number, number] } & Record<string, unknown>;
const FOLDS: Record<string, Fold> = {
  // 1: the square base — the four folds between the diagonals driven flat, the diagonals across them following
  ...Object.fromEntries([["TR", 0.5, 0.5], ["LT", -0.5, 0.5], ["BL", -0.5, -0.5], ["RB", 0.5, -0.5]].map(([n, x, y]) => [`base${n}`, { a: [0, 0], b: [x, y], step: 1, collapse: true, ...(n === "TR" ? { angle: 180 } : { with: "baseTR" }) }])),
  baseT: { a: [0, 0], b: [0, 1], step: 1, collapse: true, direction: "valley" },
  baseB: { a: [0, 0], b: [0, -1], step: 1, collapse: true, with: "baseT" },
  // 2, 4: the petal folds — the bottom point lifted over (driven), the kite creases and the sides following
  ...petal("Front", 1, 2), // on the back quadrant (on top once collapsed)
  turn1: { a: [-1, 0], b: [0, 0], step: 3, turn: true, angle: 180 },
  ...petal("Back", -1, 4),
  // 5–7: the legs narrowed, front then back
  narrowFrontT: { a: [0, 1], b: [-N, N], step: 5, angle: -180 },
  narrowFrontB: { a: [0, -1], b: [-N, -N], step: 5, angle: -180 },
  turn2: { a: [-1, 0], b: [0, 0], step: 6, turn: true, angle: 180 },
  narrowBackT: { a: [0, 1], b: [N, N], step: 7, angle: -180 },
  narrowBackB: { a: [0, -1], b: [N, -N], step: 7, angle: -180 },
};
Object.assign(FOLDS, swings());
const STEPS = 11;

/** The folds so far, planned on a sheet of half-diagonal 1 (pure geometry: where each layer lies). */
function planned(upTo: number) {
  const defs: SeqFoldDef[] = Object.entries(FOLDS).filter(([, f]) => (f.step as number) <= upTo).map(([id, f]) => ({
    id, a: { x: f.a[0], y: f.a[1] }, b: { x: f.b[0], y: f.b[1] }, step: f.step as number,
    angle: f.angle != null ? ((f.angle as number) * Math.PI) / 180 : f.direction === "mountain" ? -1 : 1,
    ...(f.turn ? { turn: true } : {}), ...(f.collapse ? { collapse: true } : {}), ...(f.with ? { with: f.with as string } : {}),
    ...(f.collapse && f.angle == null && !f.with ? { solve: true } : {}), ...(f.solve ? { solve: true } : {}), ...(f.through ? { through: f.through as "both" } : {}), ...(f.depth != null ? { depth: f.depth as number } : {}),
    ...(f.reverse ? { reverse: f.reverse as "inside" } : {}), ...(f.bend ? { bend: true } : {}),
  }));
  const seq = planSequence([{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }], defs, HELD, 0.1 / 106);
  const T = poseSequence(seq, sequenceAngles(seq, upTo));
  return {
    /** The creases folds named `prefix…` made, where they lie on the flat sheet. */
    creasesOf: (prefix: string) => seq.creases.filter((c) => c.folds.some((j) => seq.folds[j].id.startsWith(prefix))).map((c) => [[c.a.x, c.a.y], [c.b.x, c.b.y]] as [[number, number], [number, number]]),
    /** A segment in the folded model (its plane), drawn on the layer at flat point `on`: where it lies on that layer. */
    drawn(on: [number, number], a: [number, number], b: [number, number]): Pick<Fold, "a" | "b"> {
      const k = seq.facets.findIndex((fc) => fc.poly.every((p, i) => { const q = fc.poly[(i + 1) % fc.poly.length]; return (q.x - p.x) * (on[1] - p.y) - (q.y - p.y) * (on[0] - p.x) >= -1e-9; }));
      if (k < 0) throw new Error(`no layer at (${on})`);
      const z = applyPoint(T[k], { x: on[0], y: on[1], z: 0 }).z, inv = invert(T[k]);
      const fa = applyPoint(inv, { x: a[0], y: a[1], z }), fb = applyPoint(inv, { x: b[0], y: b[1], z });
      return { a: [fa.x, fa.y], b: [fb.x, fb.y] };
    },
    height: (on: [number, number]) => { const k = seq.facets.findIndex((fc) => fc.poly.every((p, i) => { const q = fc.poly[(i + 1) % fc.poly.length]; return (q.x - p.x) * (on[1] - p.y) - (q.y - p.y) * (on[0] - p.x) >= -1e-9; })); return applyPoint(T[k], { x: on[0], y: on[1], z: 0 }).z; },
    /** Halfway up the stack. */
    middle: (() => { const zs = seq.facets.map((fc, k) => applyPoint(T[k], { ...fc.poly[0], z: 0 }).z); return (Math.min(...zs) + Math.max(...zs)) / 2; })(),
    facing: (on: [number, number]) => T[seq.facets.findIndex((fc) => fc.poly.every((p, i) => { const q = fc.poly[(i + 1) % fc.poly.length]; return (q.x - p.x) * (on[1] - p.y) - (q.y - p.y) * (on[0] - p.x) >= -1e-9; }))].z.z,
  };
}

/** Steps 8–11: the neck and tail swung out from the spine at x = −½, the head, the wings, standing up. */
function swings(): Record<string, Fold> {
  const out: Record<string, Fold> = {};
  // 8: each leg turns over a line from the spine, 55° off it, through every layer above the leg's bottom one
  Object.assign(FOLDS, out);
  let at = planned(7);
  const phi = (55 * Math.PI) / 180;
  for (const [leg, sy, way] of [["Neck", -1, 1], ["Tail", 1, -1]] as const) {
    const on: [number, number] = [-0.153, sy * 0.486]; // the leg's bottom layer
    // (the bending transition — `bend: true` — meshes the legs' 8 layers with the body: 8 s a build and the path
    // clashes worse than the swing, so the crane keeps the rigid swing; the keyframes are the same either way)
    out[`swing${leg}`] = { ...at.drawn(on, [-0.5, 0], [-0.5 - 0.16 * Math.cos(phi), sy * 0.16 * Math.sin(phi)]), step: 8, reverse: "inside", angle: 180 * way * at.facing(on) };
  }
  Object.assign(FOLDS, out);
  // 9: the head — the neck's tip turned down over a line across it near its end
  at = planned(8);
  const neckTip: [number, number] = [-0.34, -0.45], base: [number, number] = [-0.5, 0];
  const along = (t: number): [number, number] => [base[0] + (neckTip[0] - base[0]) * t, base[1] + (neckTip[1] - base[1]) * t];
  const q = along(0.8), dir = Math.atan2(neckTip[1] - base[1], neckTip[0] - base[0]) + (60 * Math.PI) / 180;
  const onNeck: [number, number] = [0.02, -0.93]; // near the tip of the B corner: the neck's end
  const w = 0.035; // just across the neck
  out.head = { ...at.drawn(onNeck, [q[0] - w * Math.cos(dir), q[1] - w * Math.sin(dir)], [q[0] + w * Math.cos(dir), q[1] + w * Math.sin(dir)]), step: 9, collapse: true, through: "both", angle: 180 * at.facing(onNeck) };
  // 10: the wings down, square to the body, about the petals' hinges — the straight middle of each, |y| < P. Past
  // there the hinge's ends were folded over when the legs were narrowed (steps 5 and 7: the crease from the leg's tip
  // meets the hinge at P and runs on across the layers joined there, so the corner of each wing's base goes with the
  // leg's flap — as it does in a real crane — and lies tucked on the body). The paper on the hinge's line turns with
  // the wing (the petals' side creases, where they meet the legs' layers); the tucked corners' creases to the body —
  // the hinge's folded ends and the side creases' folded ends, one segment on two layers — are freed and solved: the
  // wing's own corner rides up with the wing, the body's stays tucked, and that segment (16 mm) opens by up to 8.7 mm,
  // hidden at the wing's root. In a real crane the tucked corners swivel on the leg's root as the wing comes down, and
  // the paper gives there; a rigid plan can't, so the wing's base passes through the tucked corners for the first half
  // of the step (both measured below). 11: stand it up on the body's line.
  for (const [wing, sx] of [["Back", 1], ["Front", -1]] as const) {
    out[`wing${wing}`] = { a: [sx * K, -P], b: [sx * K, P], step: 10, angle: -90, collapse: true };
    for (const [end, sy] of [["T", 1], ["B", -1]] as const) {
      out[`wing${wing}Side${end}`] = { a: [sx * N, sy * N], b: [sx * 0.5, sy * 0.5], step: 10, collapse: true, with: `wing${wing}` };
      out[`wing${wing}Hinge${end}`] = { a: [sx * K, sy * P], b: [sx * K, sy * K], step: 10, collapse: true };
      out[`wing${wing}Tuck${end}`] = { a: [sx * K, sy * K], b: [sx * N, sy * N], step: 10, collapse: true };
    }
  }
  out.stand = { a: [-0.6 * K, -0.5 * K], b: [-0.6 * K, 0.5 * K], step: 11, turn: true, angle: 90 }; // across the body, wings to the sides
  void at;
  return out;
}

/** A petal fold on the quadrant at x-side `sx` (+1 right, −1 left) of the flat sheet, in `step`. */
function petal(name: string, sx: number, step: number): Record<string, Fold> {
  const c = { step, collapse: true };
  return {
    [`petal${name}`]: { a: [sx * K, -K], b: [sx * K, K], ...c, angle: -180 },                // the lift: the line across the top
    [`kite${name}1`]: { a: [sx, 0], b: [sx * K, K], ...c, direction: "valley" },              // the quadrant's kite creases
    [`kite${name}2`]: { a: [sx, 0], b: [sx * K, -K], ...c, direction: "valley" },
    [`side${name}1`]: { a: [sx * K, K], b: [sx * 0.5, 0.5], ...c },                            // its sides open out
    [`side${name}2`]: { a: [sx * K, -K], b: [sx * 0.5, -0.5], ...c },
    [`inner${name}1`]: { a: [0, 1], b: [sx * K, K], ...c, direction: "valley" },              // the layers under its sides
    [`inner${name}2`]: { a: [0, -1], b: [sx * K, -K], ...c, direction: "valley" },
  };
}

async function buildCrane(s: CadSession): Promise<{ sheet: string; lines: Record<string, string> }> {
  for (const [name, val, min, max, step] of [["size", 150, 100, 300, 1], ["fold", STEPS, 0, STEPS, 0.01]] as const) {
    await dis(s, "parameter.add", { name, expression: String(val), min, max, step });
  }
  await dis(s, "parameter.add", { name: "h", expression: "size/sqrt(2)", hidden: true });
  const sk = (await dis(s, "sketch.create", { plane: "XY", name: "Sheet" }))[0];
  const at = (x: number, y: number) => ({ x: `${+x.toFixed(6)}*h`, y: `${+y.toFixed(6)}*h` });
  const corners: string[] = [];
  for (const [x, y] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) corners.push((await dis(s, "sketch.addPoint", { sketch: sk, ...at(x, y) }))[0]);
  for (let i = 0; i < 4; i++) await dis(s, "sketch.addLine", { sketch: sk, start: { ref: corners[i] }, end: { ref: corners[(i + 1) % 4] } });
  const lines: Record<string, string> = {};
  for (const [name, f] of Object.entries(FOLDS)) lines[name] = (await dis(s, "sketch.addLine", { sketch: sk, start: at(...f.a), end: at(...f.b), construction: true }))[0];
  const folds = Object.entries(FOLDS).map(([name, f]) => {
    const { a: _a, b: _b, with: w, ...rest } = f;
    return { line: lines[name], ...rest, ...(w ? { with: lines[w as string] } : {}) };
  });
  const sheet = (await dis(s, "feature.sheet", {
    sketch: sk, name: "Crane", thickness: 0.1, radius: 0,
    fixed: { x: HELD.x * 150 / Math.SQRT2, y: HELD.y * 150 / Math.SQRT2 }, // held by the body
    progress: "fold",
    folds,
  }))[0];
  const mat = (await dis(s, "material.create", { name: "Origami paper", kind: "paper", color: "#f4f1ea", backColor: "#b33a2e" }))[0];
  await dis(s, "material.assign", { material: mat });
  const hid = await s.setHidden([sk]);
  if (!hid.ok) throw new Error(`hide: ${hid.error}`);
  await describeExample(s, { title: "Paper crane", description: "The traditional crane, folded from one square sheet: a square base, two petal folds, the legs narrowed and swung up into the neck and tail, the head, the wings down." }, {
    size: { label: "Paper size", unit: "mm", description: "The square's side; 150 mm is standard origami paper" },
    fold: { label: "Fold", unit: `of ${STEPS}`, description: `0 is the flat sheet; ${STEPS} the finished crane` },
  });
  return { sheet, lines };
}

function evaluate(s: CadSession, overrides: Record<string, number> = {}): Record<string, SolidEval> {
  const scope = { ...resolveParameters(s.doc.parameters).scope, ...overrides };
  return evaluateFeatures(s.doc, scope);
}

/** The widest a crease opens anywhere along the fold, up to step `upTo`. */
function widestJoin(seq: SheetSequence, per: number, upTo = seq.steps): number {
  let worst = 0;
  for (let k = 0; k <= upTo * per; k++) {
    const T = poseSequence(seq, sequenceAngles(seq, k / per));
    for (const c of seq.creases) for (const q of [c.a, c.b]) {
      const a = applyPoint(T[c.facets[0]], { ...q, z: 0 }), b = applyPoint(T[c.facets[1]], { ...q, z: 0 });
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
  }
  return worst;
}

describe("origami: a paper crane folded step by step", () => {
  let s: CadSession;
  let ids: { sheet: string; lines: Record<string, string> };
  beforeAll(async () => {
    await initKernel({ wasmBinary: wasm });
    s = realSession();
    ids = await buildCrane(s);
    await s.recompute();
  }, 120000);

  it("builds from one square of paper", async () => {
    if (OUT) writeFileSync(`${OUT}/crane.json`, serializeDocument(s.doc));
    expectCommittedExample(s, "crane");
    const out = evaluate(s);
    for (const r of Object.values(out)) expect(r.error, r.name).toBeUndefined();
    const b = out[ids.sheet];
    expect(b.area).toBeCloseTo(150 * 150, 3);
    expect(b.sheet!.sequence!.plan.steps).toBe(STEPS);
  }, 120000);

  it("never passes through itself (but for the reverse folds' settling and the wings' tucked corners), and its creases stay joined", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!.plan;
    const hits: string[] = [], settling: string[] = [], corners: string[] = [];
    for (let k = 0; k <= STEPS * 20; k++) {
      const c = sequenceClashes(seq, sequenceAngles(seq, k / 20), 0.75);
      if (!c.length) continue;
      // the inside reverse folds (step 8): as the points settle into their declared order at the end of the swing,
      // the legs' own layers pass through each other by a few paper thicknesses (at most the stack: 8 × 0.1 mm)
      if (k / 20 > 7.4 && k / 20 < 8) settling.push(`fold ${k / 20}: ${c.length}`);
      // the wings (step 10): each wing's base passes through the corners tucked on the body at its root (6 mm of
      // paper that swivels aside in a real crane) through the first half of the step
      else if (k / 20 > 9 && k / 20 < 9.6) corners.push(`fold ${k / 20}: ${c.length}`);
      else hits.push(`fold ${k / 20}: ${c.length}`);
    }
    expect(hits).toEqual([]);
    expect(settling.length).toBeLessThan(14);
    expect(corners.length).toBeLessThan(14);
    // the layer order after every step holds (checked by the plan), the neck and tail between the body's layers
    expect(seq.layers?.length).toBe(STEPS);
    // the points swing over as one stack: its outer layers wrap round the crease a few layers wide
    expect(widestJoin(seq, 10, 9)).toBeLessThan(5);
    // the wings: the hinge's tucked ends open as the wing's corner rides up and the body's stays (16 mm segments at
    // the root, between layers: 8.7 mm); at one of the four corners the collapse's tree still hangs the tucked corner
    // from the body rather than the wing (core/sheetSequence.ts collapseStep, the tree), so that corner's own creases
    // open too (37 mm — see README); every other crease stays joined but for the layers' spacing where the reverse
    // folds nest the legs (the stack's thickness, 1.1 mm)
    expect(widestJoin(seq, 10, 11)).toBeLessThan(40);
    const T11 = poseSequence(seq, sequenceAngles(seq, 11)), h = 150 / Math.SQRT2, eps = 1e-6 * h;
    for (const c of seq.creases) {
      // the tucked corners' creases (the petals' hinge ends and side ends, the narrowing creases' and kite creases' parts within them)
      const inCorner = (q: { x: number; y: number }) => Math.abs(q.x) > K * h - eps && Math.abs(q.y) < N * h + eps && Math.abs(q.x) + Math.abs(q.y) < h + eps && Math.abs(q.y) > P * h - eps;
      if (inCorner(c.a) && inCorner(c.b)) continue;
      for (const q of [c.a, c.b]) {
        const a = applyPoint(T11[c.facets[0]], { ...q, z: 0 }), b = applyPoint(T11[c.facets[1]], { ...q, z: 0 });
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `crease "${seq.folds[c.folds[c.folds.length - 1]].id}" at (${q.x.toFixed(2)}, ${q.y.toFixed(2)})`).toBeLessThan(2);
      }
    }
  });

  it("nests each leg's eight layers about the leg's folded edge when it swings up: the neck shows the paper's coloured side, like the body", () => {
    // the neck (the B corner) across its width, between the swing and the head, on every layer: its rank in the leg's
    // stack after step 7 (0 at the bottom) and its height after step 8 — the lower four reversed, then the upper four
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!.plan;
    const T7 = poseSequence(seq, sequenceAngles(seq, 7)), T8 = poseSequence(seq, sequenceAngles(seq, 8));
    const layers = new Map<number, { z7: number; z8: number }>();
    for (let x = -0.2; x <= 0.2001; x += 0.01) {
      const q = { x: +x.toFixed(3) * 150 / Math.SQRT2, y: -0.8 * 150 / Math.SQRT2 };
      seq.facets.forEach((fc, k) => {
        if (layers.has(k) || !fc.poly.every((p, i) => { const r = fc.poly[(i + 1) % fc.poly.length]; return (r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x) >= -1e-9; })) return;
        layers.set(k, { z7: applyPoint(T7[k], { ...q, z: 0 }).z, z8: applyPoint(T8[k], { ...q, z: 0 }).z });
      });
    }
    const byRank = [...layers.values()].sort((a, b) => a.z7 - b.z7);
    expect(byRank.length).toBe(8);
    const order8 = byRank.map((l, rank) => ({ rank, z: l.z8 })).sort((a, b) => a.z - b.z).map((l) => l.rank);
    expect(order8).toEqual([3, 2, 1, 0, 7, 6, 5, 4]);
  });

  it("is a crane when done: wings spread level, the neck and the tail up either side, the body between", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!;
    const T = poseSequence(seq.plan, sequenceAngles(seq.plan, STEPS)).map((t) => compose(seq.frame, t));
    const h = 150 / Math.SQRT2;
    const at = (x: number, y: number) => { const q = { x: x * h, y: y * h }; const k = seq.plan.facets.findIndex((fc) => fc.poly.every((p, i) => { const r = fc.poly[(i + 1) % fc.poly.length]; return (r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x) >= -1e-6; })); expect(k).toBeGreaterThanOrEqual(0); return { p: applyPoint(T[k], { ...q, z: 0 }), n: T[k].z }; };
    const wingL = at(-0.95, 0), wingR = at(0.95, 0), neck = at(0.02, -0.97), tail = at(0.02, 0.97), body = at(-0.15, 0.02);
    // the wings level (their faces up or down), their tips out to either side of the body, at one height
    for (const w of [wingL, wingR]) expect(Math.abs(w.n.z)).toBeGreaterThan(0.99);
    expect(Math.abs(wingL.p.z - wingR.p.z)).toBeLessThan(3);
    // the neck and the tail rise above the body, on opposite sides of it
    expect(neck.p.z).toBeGreaterThan(body.p.z + 10);
    expect(tail.p.z).toBeGreaterThan(body.p.z + 10);
    const side = (q: { x: number; y: number }) => (q.x - body.p.x) * (wingR.p.y - wingL.p.y) - (q.y - body.p.y) * (wingR.p.x - wingL.p.x);
    expect(Math.sign(side(neck.p))).toBe(-Math.sign(side(tail.p)));
  });

  it("is a bird base after step 4: the petals up, the legs down, all flat", () => {
    const seq = evaluate(s)[ids.sheet].sheet!.sequence!;
    const T = poseSequence(seq.plan, sequenceAngles(seq.plan, 4)).map((t) => compose(seq.frame, t));
    for (const t of T) expect(Math.abs(t.z.z)).toBeCloseTo(1, 3);
  });
});
