// Build a sheet's geometry from its state (core/sheet.ts): the blank, split
// into panels and bend pieces, planned, folded — and its flat pattern.

import type { Shape3D } from "replicad";
import { SheetState, SheetFold, FlatPattern, FlatFoldLine, planFold, cornerReliefs, outlineItem, flatBounds, bendAllowance, insideSegs, isSequenced } from "./sheet";
import { blankFace, splitBlank, foldedSheet, flatSheet, faceEdges, loopsFace, Strip, BendPlacement, WedgePlacement } from "./occ/sheet";
import { planSequence, sequenceAngles, poseSequence, sequenceFaces } from "./sheetSequence";

export interface SheetBuild { shape: Shape3D; state: SheetState; pattern: FlatPattern; warnings: string[] }

const deg = (r: number) => (r * 180) / Math.PI;

export function buildSheet(s: SheetState): SheetBuild {
  if (isSequenced(s)) return buildSequenced(s);
  const blank = blankFace(s.base, [...s.ops, ...cornerReliefs(s.folds)]);
  let split: ReturnType<typeof splitBlank> | undefined;
  try {
    const outline = faceEdges(blank).map((e) => outlineItem(e.type, e.pts));
    const { min, max } = flatBounds(outline);
    const t = s.thickness;
    const line = (f: SheetFold, angle: number, a = f.a, b = f.b): FlatFoldLine => ({ id: f.id, a, b, angle: deg(angle), radius: f.radius, allowance: bendAllowance(angle, f.radius, s) });
    const pattern = (lines: FlatFoldLine[]): FlatPattern => ({ outline, folds: lines, min, max, thickness: t, kFactor: s.kFactor });

    if (s.unfolded) {
      const shape = flatSheet(blank, t, s.frame);
      return { shape, state: { ...s, edited: false }, pattern: pattern(s.folds.map((f) => line(f, f.angle ?? s.angles?.[f.id] ?? 0))), warnings: [] };
    }

    // folds that turn: bends (a zone of the blank) or creases (a hinge line)
    const active = s.folds.filter((f) => f.angle == null || Math.abs(f.angle) > 1e-9);
    const strips: Strip[] = [], stripFold: number[] = [], creases: { a: typeof s.fixed; b: typeof s.fixed }[] = [];
    active.forEach((f, i) => {
      if (f.radius > 0 && f.angle != null) {
        strips.push({ a: f.a, b: f.b, half: bendAllowance(f.angle, f.radius, s) / 2, extend: !!f.extend, id: f.id });
        stripFold.push(i);
      } else creases.push({ a: f.a, b: f.b });
    });
    // an extended bend keeps only the stretch of its zone its own line runs through
    const onLine = (strip: number, segs: [typeof s.fixed, typeof s.fixed][]) => {
      const { a, b } = strips[strip];
      for (let k = 1; k < 10; k++) if (insideSegs({ x: a.x + ((b.x - a.x) * k) / 10, y: a.y + ((b.y - a.y) * k) / 10 }, segs)) return true;
      return false;
    };
    split = splitBlank(blank, strips, creases, onLine);
    const plan = planFold(s, active, split.panels.map((p) => p.segs), split.pieces.map((p) => ({ fold: stripFold[p.strip], segs: p.segs })));

    const bends: BendPlacement[] = [], wedges: WedgePlacement[] = [];
    for (const l of plan.links) {
      const g = plan.geo[l.fold], angle = plan.angles[l.fold];
      if (l.piece >= 0) bends.push({ face: split.pieces[l.piece].face, T: plan.panelT[l.minus], O: g.O, e: g.e, d: g.d, half: g.half, angle, radius: active[l.fold].radius });
      else if (t > 0 && Math.abs(angle) > 1e-9) wedges.push({ T: plan.panelT[l.minus], O: g.O, e: g.e, s0: l.s0, s1: l.s1, angle });
    }
    const shape = foldedSheet(split.panels.map((p, i) => ({ face: p.face, T: plan.panelT[i] })), bends, wedges, t, s.frame);
    const panels = split.panels;

    // fold lines where they actually cross the blank
    const lines = active.map((f, i) => {
      const ls = plan.links.filter((l) => l.fold === i);
      const g = plan.geo[i];
      const s0 = Math.min(...ls.map((l) => l.s0)), s1 = Math.max(...ls.map((l) => l.s1));
      const at = (k: number) => ({ x: g.O.x + g.e.x * k, y: g.O.y + g.e.y * k });
      return line(f, plan.angles[i], at(s0), at(s1));
    });
    const angles = Object.fromEntries(active.map((f, i) => [f.id, plan.angles[i]]));
    return {
      shape,
      state: { ...s, edited: false, panels: panels.map((p, i) => ({ T: plan.panelT[i], segs: p.segs })), angles },
      pattern: pattern(lines),
      warnings: plan.warnings,
    };
  } finally {
    for (const x of [...(split?.panels ?? []), ...(split?.pieces ?? [])]) { try { x.face.delete(); } catch { /* shared with the blank */ } }
    blank.delete();
  }
}

/** Least space between stacked layers of paper folded in steps: enough that they never share a depth. */
export const MIN_LAYER_GAP = 0.02;

/**
 * Paper folded in steps (core/sheetSequence.ts): planned in pure geometry, then
 * each flat face — facets joined across creases not made yet — placed as a face
 * (paper is drawn as its surface; the thickness spaces the layers).
 */
function buildSequenced(s: SheetState): SheetBuild {
  const blank = blankFace(s.base, s.ops);
  const faces: { delete?(): void }[] = [];
  try {
    const edges = faceEdges(blank);
    const outline = edges.map((e) => outlineItem(e.type, e.pts));
    const { min, max } = flatBounds(outline);
    if (edges.some((e) => e.type !== "LINE")) throw new Error("folding in steps needs a sheet with straight edges (a convex polygon)");
    // the blank's outline in order: each edge's start, walking the loop
    const segs = edges.map((e) => [e.pts[0], e.pts[e.pts.length - 1]] as const);
    const loop = [segs[0][0], segs[0][1]];
    const left = segs.slice(1);
    while (left.length) {
      const end = loop[loop.length - 1];
      const k = left.findIndex(([a, b]) => Math.hypot(a.x - end.x, a.y - end.y) < 1e-6 || Math.hypot(b.x - end.x, b.y - end.y) < 1e-6);
      if (k < 0) throw new Error("folding in steps needs a sheet of one piece, without holes");
      const [a, b] = left.splice(k, 1)[0];
      loop.push(Math.hypot(a.x - end.x, a.y - end.y) < 1e-6 ? b : a);
    }
    loop.pop(); // back at the start
    const gap = Math.max(s.thickness, MIN_LAYER_GAP);
    for (const f of s.folds) if (f.angle == null) throw new Error(`fold "${f.id}" needs an angle (folds made in steps aren't solved)`);
    const seq = planSequence(loop, s.folds.map((f) => ({ id: f.id, a: f.a, b: f.b, angle: f.angle!, step: f.step!, turn: f.turn, flip: f.flip, collapse: f.collapse, with: f.with, solve: f.solve, through: f.through, depth: f.depth, bend: f.bend })), s.fixed, gap);
    const crease = seq.creases.filter((c) => !c.bend).map((c) => ({ id: seq.folds[c.folds[c.folds.length - 1]].id, a: c.a, b: c.b, angle: deg(c.angle), radius: 0, allowance: 0 }));
    const pattern: FlatPattern = { outline, folds: crease, min, max, thickness: s.thickness, kFactor: s.kFactor };
    const angles = sequenceAngles(seq, s.unfolded ? 0 : s.progress);
    const T = poseSequence(seq, angles);
    const parts = sequenceFaces(seq, angles).map((g) => { const face = loopsFace(g.loops); faces.push(face); return { face, T: T[g.facets[0]] }; });
    const shape = foldedSheet(parts, [], [], 0, s.frame);
    const named: Record<string, number> = {};
    seq.folds.forEach((f, j) => { named[f.turn ? `${f.id}:turn` : named[f.id] != null ? `${f.id}@${f.step}` : f.id] = angles[j]; });
    return {
      shape,
      state: { ...s, edited: false, seq, angles: named, panels: seq.facets.map((f, i) => ({ T: T[i], segs: f.poly.map((p, k) => [p, f.poly[(k + 1) % f.poly.length]] as [typeof p, typeof p]) })) },
      pattern,
      warnings: [],
    };
  } finally {
    for (const f of faces) { try { f.delete?.(); } catch { /* freed with the shape */ } }
    blank.delete();
  }
}
