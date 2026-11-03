// The Folds panel's model: a sheet's folds as steps, and the edits a person makes to them (add, remove,
// move to another step, insert a step, change a fold's operation), each returning the whole new list that
// feature.sheet.edit takes. Pure (no React, no store): tested in Node (test/sheetEdit.test.ts).
//
// EXPERIMENTAL, like all paper folding: see the note and known gaps at the top of core/sheetSequence.ts.

import type { SheetFoldDef } from "../core/document";

/** What a fold does at its step, as the panel's operation select names it. */
export type FoldOp = "fold" | "turn" | "collapse" | "through" | "reverse-inside" | "reverse-outside" | "bend";

export const FOLD_OPS: { key: FoldOp; label: string; title: string }[] = [
  { key: "fold", label: "Fold", title: "A plain fold: the flap beyond the line turns by the angle" },
  { key: "turn", label: "Turn over", title: "Turn the whole model about the line (180 = turn over), creasing nothing" },
  { key: "collapse", label: "Collapse", title: "A crease of a collapse: every fold of the step moves at once (a squash, a petal fold)" },
  { key: "through", label: "Through stack", title: "A collapse crease carried on through the layers stacked on it" },
  { key: "reverse-inside", label: "Reverse (inside)", title: "An inside reverse fold: the point folds back between its own halves" },
  { key: "reverse-outside", label: "Reverse (outside)", title: "An outside reverse fold: the point wraps round its own halves" },
  { key: "bend", label: "Bend", title: "A collapse in which the paper may bend (moved by least energy, not rigidly)" },
];

export function foldOp(f: SheetFoldDef): FoldOp {
  if (f.reverse) return f.reverse === "outside" ? "reverse-outside" : "reverse-inside";
  if (f.turn) return "turn";
  if (f.collapse && f.bend) return "bend";
  if (f.collapse && f.through) return "through";
  if (f.collapse) return "collapse";
  return "fold";
}

/** The fold made with another operation (the flags of the old one cleared; `through` for a through-stack crease). */
export function withOp(f: SheetFoldDef, op: FoldOp, through: "up" | "down" | "both" = f.through ?? "both"): SheetFoldDef {
  const { turn: _t, collapse: _c, through: _th, depth: _d, bend: _b, reverse: _r, with: w, ...rest } = f;
  const collapse = op === "collapse" || op === "through" || op === "bend";
  const out: SheetFoldDef = { ...rest };
  if (op === "turn") out.turn = true;
  if (collapse) out.collapse = true;
  if (collapse && w) out.with = w;
  if (op === "through") { out.through = through; if (f.depth != null) out.depth = f.depth; }
  if (op === "bend") out.bend = true;
  if (op === "reverse-inside") out.reverse = "inside";
  if (op === "reverse-outside") out.reverse = "outside";
  if (!collapse && !out.reverse && (out.angleExpr == null || out.angleExpr === "")) out.angleExpr = out.direction === "mountain" ? "-180" : "180";
  return out;
}

/** The angle's expression is a plain number. */
const numeric = (s: string | undefined) => s != null && s.trim() !== "" && Number.isFinite(Number(s));

/** A valley (+, toward the top) unless its angle or direction says mountain. */
export function isValley(f: SheetFoldDef): boolean {
  if (numeric(f.angleExpr)) return Number(f.angleExpr) >= 0;
  if (f.angleExpr && /^\s*-/.test(f.angleExpr)) return false;
  return f.direction !== "mountain";
}

/** The fold turned the other way: a valley made a mountain or back (its angle's sign and its direction). */
export function toggleValley(f: SheetFoldDef): SheetFoldDef {
  const valley = !isValley(f);
  const out: SheetFoldDef = { ...f, direction: valley ? "valley" : "mountain" };
  const a = f.angleExpr?.trim();
  if (a) {
    if (numeric(a)) out.angleExpr = String(-Number(a));
    else { const m = /^-\((.*)\)$/.exec(a); out.angleExpr = m ? m[1] : `-(${a})`; }
  }
  return out;
}

/** The angle a person types, given its sign by valley/mountain when it's a bare number ("" = solved). */
export function withAngle(f: SheetFoldDef, text: string): SheetFoldDef {
  const t = text.trim();
  const { angleExpr: _a, ...rest } = f;
  if (!t) return rest;
  if (numeric(t)) {
    const n = Number(t);
    return { ...rest, angleExpr: String(n), direction: n < 0 ? "mountain" : "valley" };
  }
  return { ...rest, angleExpr: t };
}

/** How many steps (the highest step; 0 when the folds aren't made in steps). */
export function stepCount(folds: readonly SheetFoldDef[]): number {
  return folds.reduce((m, f) => Math.max(m, f.step ?? 0), 0);
}

/** The folds are made in steps (or there are none yet, so the next ones will be). */
export function isStepped(folds: readonly SheetFoldDef[]): boolean {
  return folds.every((f) => f.step != null);
}

/** Each step's folds (with their index in the list), steps 1…M in order; an empty step still gets its group.
 *  Folds made without steps (folded at once) are the group of step 0. */
export function stepGroups(folds: readonly SheetFoldDef[]): { step: number; folds: { fold: SheetFoldDef; index: number }[] }[] {
  const M = stepCount(folds);
  const groups = Array.from({ length: M }, (_, i) => ({ step: i + 1, folds: [] as { fold: SheetFoldDef; index: number }[] }));
  const loose: { fold: SheetFoldDef; index: number }[] = [];
  folds.forEach((fold, index) => (fold.step != null && fold.step >= 1 ? groups[fold.step - 1].folds : loose).push({ fold, index }));
  return loose.length ? [{ step: 0, folds: loose }, ...groups] : groups;
}

/** A `with` that no longer names another fold of the same step is dropped. */
function tidyWith(folds: SheetFoldDef[]): SheetFoldDef[] {
  return folds.map((f) => {
    if (!f.with || folds.some((o) => o !== f && o.line === f.with && o.step === f.step)) return f;
    const { with: _w, ...rest } = f;
    return rest;
  });
}

/** Steps renumbered 1…k in order, no step left empty. */
export function compactSteps(folds: readonly SheetFoldDef[]): SheetFoldDef[] {
  const used = [...new Set(folds.map((f) => f.step).filter((s): s is number => s != null))].sort((a, b) => a - b);
  const to = new Map(used.map((s, i) => [s, i + 1]));
  return tidyWith(folds.map((f) => (f.step != null ? { ...f, step: to.get(f.step)! } : { ...f })));
}

/** An empty step made at `at`: the folds of step `at` and later move one step on. */
export function insertStep(folds: readonly SheetFoldDef[], at: number): SheetFoldDef[] {
  return folds.map((f) => (f.step != null && f.step >= at ? { ...f, step: f.step + 1 } : { ...f }));
}

/** New folds along `lines` at `step` (one past the last = a new step; undefined = folded at once). */
export function addFolds(folds: readonly SheetFoldDef[], lines: readonly string[], step: number | undefined, angle = 180): SheetFoldDef[] {
  const added = lines.map((line): SheetFoldDef => ({ line, angleExpr: String(angle), direction: angle < 0 ? "mountain" : "valley", ...(step != null ? { step } : {}) }));
  return compactSteps([...folds, ...added]);
}

export function removeFold(folds: readonly SheetFoldDef[], index: number): SheetFoldDef[] {
  return compactSteps(folds.filter((_, i) => i !== index));
}

/** The fold `index` moved a step earlier (−1) or later (+1): it joins the neighbouring step's folds (its own step,
 *  left empty, goes); moved past the first or last step out of a step it shares, it gets a new step of its own
 *  there. Steps are renumbered after. */
export function moveFold(folds: readonly SheetFoldDef[], index: number, delta: -1 | 1): SheetFoldDef[] {
  const f = folds[index];
  if (f?.step == null) return folds.map((x) => ({ ...x }));
  const M = stepCount(folds);
  const alone = folds.filter((x) => x.step === f.step).length === 1;
  const target = f.step + delta;
  if (target < 1 || target > M) {
    if (alone) return folds.map((x) => ({ ...x })); // already a first/last step of its own
    if (target < 1) return compactSteps(folds.map((x, i) => ({ ...x, step: i === index ? 1 : x.step! + 1 })));
    return compactSteps(folds.map((x, i) => (i === index ? { ...x, step: M + 1 } : { ...x })));
  }
  return compactSteps(folds.map((x, i) => (i === index ? { ...x, step: target } : { ...x })));
}

/** The command's fold items (feature.sheet / feature.sheet.edit `folds`) for these folds. */
export function foldsToParams(folds: readonly SheetFoldDef[]): Record<string, unknown>[] {
  return folds.map(({ angleExpr, radiusExpr, ...rest }) => ({ ...rest, ...(angleExpr != null && angleExpr !== "" ? { angle: angleExpr } : {}), ...(radiusExpr != null && radiusExpr !== "" ? { radius: radiusExpr } : {}) }));
}

/** A sheet's error, split: the parts that name a step (the planner's "step 4 (fold …): …") by that step, the rest on top. */
export function splitFoldErrors(error: string | undefined): { top: string[]; byStep: Record<number, string[]> } {
  const top: string[] = [];
  const byStep: Record<number, string[]> = {};
  if (!error) return { top, byStep };
  for (const part of error.split(/;\s+(?=step \d)/)) {
    const m = /\bstep (\d+)\b/.exec(part);
    if (m) (byStep[Number(m[1])] ??= []).push(part.trim());
    else top.push(part.trim());
  }
  return { top, byStep };
}

/** The parameter an expression is, when it is one bare name of `names` (the slider can drive it); else null. */
export function plainParam(expr: string | undefined, names: readonly string[]): string | null {
  const t = expr?.trim() ?? "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && names.includes(t) ? t : null;
}

/** `base`, or base2, base3… — the first not in `names`. */
export function uniqueName(base: string, names: readonly string[]): string {
  if (!names.includes(base)) return base;
  for (let i = 2; ; i++) if (!names.includes(`${base}${i}`)) return `${base}${i}`;
}

/** Paper sizes for a new sheet (mm). */
export const PAPER_PRESETS: { key: string; label: string; w: number; h: number }[] = [
  { key: "kami15", label: "Kami 15 cm", w: 150, h: 150 },
  { key: "kami24", label: "Kami 24 cm", w: 240, h: 240 },
  { key: "a4", label: "A4", w: 210, h: 297 },
  { key: "letter", label: "US letter", w: 215.9, h: 279.4 },
  { key: "custom", label: "Custom…", w: 100, h: 100 },
];
