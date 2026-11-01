// The Lens's logic and private state: where the lens is, what it shows, what
// is under it. Pure functions (tested in Node) plus a small zustand store the
// overlay components read; nothing here touches React or the scene. Whether
// the lens is shown is useUi.panels.lens, like every other panel.

import { create } from "zustand";
import { placeCard, clampInside, type Box, type Pt } from "../../kit/anchor";
import { arrowDir } from "../../kit/numberMath";
import { boundsCentre } from "../../../model/concepts/featureCatalog";
import type { SolidEval } from "../../../core/features";
import { OVERHANG_AMBER_SIN, OVERHANG_RED_SIN, type LensMode, type LensShape, type LensSpec } from "../../../viewport/lensPass";
import type { FlexureState, StrainSegment } from "../../../sim/flexure";
import { worstFlexure } from "../../../model/concepts/mechanism";

export { boundsCentre };

export type { LensMode, LensShape, LensSpec };
export type LensSize = "S" | "M" | "L";
/** How the part sits on the print bed: standing (+Z up), on its back (the +Y face down), upside down. */
export type Orient = "standing" | "back" | "upsideDown";

export interface LensState {
  mode: LensMode;
  shape: LensShape;
  size: LensSize;
  /** Circle centre, viewport-local CSS px; -1 until first placed. */
  x: number;
  y: number;
  /** The wipe line's x; -1 until first placed. */
  wipeX: number;
  orient: Orient;
}

/** The geometry of the lens on screen (what the frame draws and the pass masks to). */
export interface LensFrame {
  shape: LensShape;
  x: number;
  y: number;
  r: number;
  wipeX: number;
}

export const MODES: { key: LensMode; label: string; title: string }[] = [
  { key: "zebra", label: "Zebra", title: "Reflected stripes: breaks and kinks show surface continuity" },
  { key: "draft", label: "Draft", title: "Faces that draft out of the mould along the pull direction" },
  { key: "curvature", label: "Curvature", title: "Blue concave, white flat, red convex" },
  { key: "xray", label: "X-ray", title: "Bodies as glass with every edge, so holes read through" },
  { key: "overhang", label: "Overhang", title: "Faces that need support when printed" },
  { key: "strain", label: "Strain", title: "Each flexure coloured by its peak bending strain against its material's limit" },
];
export const SHAPES: { key: LensShape; label: string }[] = [{ key: "lens", label: "Lens" }, { key: "wipe", label: "Wipe" }];
/** The shape pills: the lens, the wipe, and the whole view (a wipe at the left edge: the analysis everywhere). */
export type ShapeChoice = LensShape | "whole";
export const SHAPE_CHOICES: { key: ShapeChoice; label: string; title?: string }[] = [...SHAPES, { key: "whole", label: "Whole view", title: "The analysis over the whole view" }];
/** Which shape pill is lit: a wipe at the left edge is the whole view. */
export function shapeChoice(shape: LensShape, wipeX: number): ShapeChoice {
  return shape === "wipe" && wipeX <= 0 && wipeX !== -1 ? "whole" : shape;
}
export const SIZES: { key: LensSize; label: string }[] = [{ key: "S", label: "S" }, { key: "M", label: "M" }, { key: "L", label: "L" }];
export const ORIENTS: { key: Orient; label: string; title: string }[] = [
  { key: "standing", label: "Standing", title: "Printed as modelled, +Z up" },
  { key: "back", label: "On back", title: "Laid on its back: the +Y face on the bed" },
  { key: "upsideDown", label: "Upside down", title: "Flipped: the top face on the bed" },
];
export const MODE_LABEL: Record<LensMode, string> = Object.fromEntries(MODES.map((m) => [m.key, m.label])) as Record<LensMode, string>;

/** The circle's radius for a size, as a share of the viewport's shorter side (clamped so it stays usable). */
export function lensRadius(size: LensSize, bounds: Box): number {
  const f = size === "S" ? 0.12 : size === "L" ? 0.3 : 0.2;
  const m = Math.min(bounds.w, bounds.h);
  return Math.min(Math.max(40, Math.round(m * f)), Math.floor(m / 2) - 4);
}

/** Where a lens first appears: centred, wipe at the middle. */
export function initialPosition(bounds: Box): { x: number; y: number; wipeX: number } {
  return { x: Math.round(bounds.w / 2), y: Math.round(bounds.h / 2), wipeX: Math.round(bounds.w / 2) };
}

/** Keep the circle inside the viewport (centred when it cannot fit) and the wipe line on screen. */
export function clampLens(p: { x: number; y: number; wipeX: number }, r: number, bounds: Box): { x: number; y: number; wipeX: number } {
  const clampAxis = (v: number, len: number) => (len < 2 * r ? len / 2 : Math.max(r, Math.min(len - r, v)));
  return { x: clampAxis(p.x, bounds.w), y: clampAxis(p.y, bounds.h), wipeX: Math.max(0, Math.min(bounds.w, p.wipeX)) };
}

/** The lens frame for a state in a viewport (positions placed if still unset). */
export function frameOf(s: Pick<LensState, "shape" | "size" | "x" | "y" | "wipeX">, bounds: Box): LensFrame {
  const r = lensRadius(s.size, bounds);
  const init = initialPosition(bounds);
  const p = clampLens({ x: s.x < 0 ? init.x : s.x, y: s.y < 0 ? init.y : s.y, wipeX: s.wipeX < 0 ? init.wipeX : s.wipeX }, r, bounds);
  return { shape: s.shape, r, ...p };
}

/** Is a viewport-local point under the lens (inside the circle, or right of the wipe)? */
export function inLens(f: LensFrame, p: Pt): boolean {
  return f.shape === "lens" ? Math.hypot(p.x - f.x, p.y - f.y) <= f.r : p.x >= f.wipeX;
}

/** How many of the given screen points are under the lens (hidden ones never count). */
export function countInside(f: LensFrame, pts: { x: number; y: number; visible: boolean }[]): number {
  return pts.reduce((n, p) => n + (p.visible && inLens(f, p) ? 1 : 0), 0);
}

/** The drag handle: on the circle's rim at 45° below right, or the middle of the wipe line. */
export function handlePos(f: LensFrame, bounds: Box): Pt {
  if (f.shape === "lens") return { x: f.x + f.r * Math.SQRT1_2, y: f.y + f.r * Math.SQRT1_2 };
  return { x: f.wipeX, y: bounds.h / 2 };
}

/** The lens after dragging it: the pointer's position less where it grabbed, clamped. */
export function dragTo(f: LensFrame, grab: Pt, pointer: Pt, bounds: Box): { x: number; y: number; wipeX: number } {
  const dx = pointer.x - grab.x, dy = pointer.y - grab.y;
  return clampLens({ x: f.x + dx, y: f.y + dy, wipeX: f.wipeX + dx }, f.r, bounds);
}

/** Build direction in world space for a print orientation. */
export function orientUp(o: Orient): { x: number; y: number; z: number } {
  return o === "back" ? { x: 0, y: -1, z: 0 } : o === "upsideDown" ? { x: 0, y: 0, z: -1 } : { x: 0, y: 0, z: 1 };
}

export type OverhangClass = "bed" | "steep" | "mild" | "neutral";
/** What the overhang shader paints a face: `d` = normal · up, `h` = height above the bed (mirrors lensPass.ts). */
export function overhangClass(d: number, h: number, bedTol = 0.01): OverhangClass {
  if (d < -0.95 && h < bedTol) return "bed";
  if (d < -OVERHANG_RED_SIN) return "steep";
  if (d < -OVERHANG_AMBER_SIN) return "mild";
  return "neutral";
}

/** The band along the top of the view the HUD keeps clear of: the panel switches and the component crumb
 *  (one line each, 12 px from the top, 28 px high) and a gap. */
export const HUD_TOP_KEEPOUT = 52;

/** Where the HUD card sits: off the circle's right rim, or beside the wipe line's top; flipped and clamped
 *  inside, and never in the top `keepTop` px (the switches and the crumb). */
export function hudPlacement(f: LensFrame, card: Box, bounds: Box, keepTop = 0): Pt {
  if (keepTop > 0 && bounds.h - keepTop > card.h + 16) {
    const p = hudPlacement({ ...f, y: f.y - keepTop }, card, { w: bounds.w, h: bounds.h - keepTop });
    return { x: p.x, y: p.y + keepTop };
  }
  if (f.shape === "lens") {
    // beside the lens, never over it: right of its right edge, else left of its left edge, else under it
    const y = f.y - f.r * 0.5, gap = 16, m = 8;
    if (f.x + f.r + gap + card.w + m <= bounds.w) return placeCard({ anchor: { x: f.x + f.r, y }, size: card, bounds, prefer: "right", gap });
    if (f.x - f.r - gap - card.w - m >= 0) return placeCard({ anchor: { x: f.x - f.r, y }, size: card, bounds, prefer: "left", gap });
    const cx = f.x - card.w / 2 + 8;
    if (f.y + f.r + gap + card.h + m <= bounds.h) return placeCard({ anchor: { x: cx, y: f.y + f.r }, size: card, bounds, prefer: "below", gap });
    if (f.y - f.r - gap - card.h - m >= 0) return placeCard({ anchor: { x: cx, y: f.y - f.r }, size: card, bounds, prefer: "above", gap });
    // no room on any side: dock it in the corner farthest from the lens
    return clampInside({ x: f.x < bounds.w / 2 ? bounds.w : 0, y: f.y < bounds.h / 2 ? bounds.h : 0 }, card, bounds, m);
  }
  return placeCard({ anchor: { x: f.wipeX, y: 12 }, size: card, bounds, prefer: "right", gap: 12 });
}

export { clampInside };

export interface AnalysisParams {
  stripes: number;
  draftDeg: number;
  pull: { x: number; y: number; z: number };
  quantity: "mean" | "gaussian" | "max" | "min";
}

/** The settings each mode's card can change (the Lens is their one home): readouts of the same name give way to them. */
export const SETTING_LABELS = new Set(["Stripes", "Draft angle", "Pull", "Quantity"]);
export const STRIPES = { min: 2, max: 60, step: 2 };
export const DRAFT = { min: 0, max: 45, step: 0.5 };
export const QUANTITIES: { key: AnalysisParams["quantity"]; label: string }[] = [{ key: "mean", label: "Mean" }, { key: "gaussian", label: "Gaussian" }, { key: "max", label: "Max" }, { key: "min", label: "Min" }];
export const PULLS: { key: "Z" | "Y" | "X"; label: string }[] = [{ key: "Z", label: "+Z" }, { key: "Y", label: "+Y" }, { key: "X", label: "+X" }];
export const pullKey = (p: AnalysisParams["pull"]): "X" | "Y" | "Z" => (p.x ? "X" : p.y ? "Y" : "Z");
export const pullOf = (k: "X" | "Y" | "Z") => ({ x: k === "X" ? 1 : 0, y: k === "Y" ? 1 : 0, z: k === "Z" ? 1 : 0 });
/** A stepped value, clamped to its range and rounded to its step. */
export function stepTo(v: number, d: number, r: { min: number; max: number; step: number }): number {
  const n = Math.round((v + d * r.step) / r.step) * r.step;
  return +Math.min(r.max, Math.max(r.min, n)).toFixed(3);
}

/** The area (mm²) of the faces that need support in a print orientation, and of every face, summed over the
 *  display meshes' triangles (an estimate: the mesh, not the B-rep). A face on the bed never counts. */
export function supportArea(meshes: { positions: ArrayLike<number>; indices: ArrayLike<number> }[], up: { x: number; y: number; z: number }): { steep: number; mild: number; total: number } {
  let bed = Infinity;
  for (const m of meshes) for (let i = 0; i + 2 < m.positions.length; i += 3) bed = Math.min(bed, m.positions[i] * up.x + m.positions[i + 1] * up.y + m.positions[i + 2] * up.z);
  let steep = 0, mild = 0, total = 0;
  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!len) continue;
      const area = len / 2;
      total += area;
      const d = (nx * up.x + ny * up.y + nz * up.z) / len;
      const h = Math.max(...[a, b, c].map((k) => P[k] * up.x + P[k + 1] * up.y + P[k + 2] * up.z)) - bed;
      const cls = overhangClass(d, h);
      if (cls === "steep") steep += area; else if (cls === "mild") mild += area;
    }
  }
  return { steep, mild, total };
}

/** "1,240 mm²", "12.4 cm²". */
function areaText(mm2: number): string {
  if (mm2 >= 1e4) return `${(mm2 / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })} cm²`;
  return `${Math.round(mm2).toLocaleString("en-US")} mm²`;
}

/** The spec the 3D pass renders from (with the strain field, in strain mode). */
export function toLensSpec(s: Pick<LensState, "mode" | "orient">, f: LensFrame, a: AnalysisParams, strain?: StrainSegment[]): LensSpec {
  return {
    mode: s.mode, shape: f.shape, x: f.x, y: f.y, r: f.r, wipeX: f.wipeX, up: orientUp(s.orient), stripes: a.stripes, draftDeg: a.draftDeg, pull: a.pull, quantity: a.quantity,
    ...(s.mode === "strain" ? { strain: strain ?? [] } : {}),
  };
}

export interface LegendSpec { rows?: { color: string; label: string }[]; ramp?: { css: string; min: string; mid?: string; max: string } }

/** The legend for a mode (colours are the ones the shaders paint). */
export function legendFor(mode: LensMode): LegendSpec {
  switch (mode) {
    // the --k-an-* tokens in kit.css mirror the shader colours (SceneManager.analysisMaterial / lensPass.ts)
    case "zebra": return { ramp: { css: "var(--k-an-zebra)", min: "break = crease", mid: "kink = tangent", max: "smooth = G2" } };
    case "draft": return { rows: [{ color: "var(--k-an-draft-ok)", label: "Drafts out along the pull" }, { color: "var(--k-an-draft-steep)", label: "Steeper than the draft angle" }, { color: "var(--k-an-undercut)", label: "Undercut" }] };
    case "curvature": return { ramp: { css: "var(--k-an-curvature)", min: "concave", mid: "flat", max: "convex" } };
    case "xray": return { rows: [{ color: "var(--k-an-glass)", label: "Body as glass" }, { color: "var(--k-an-edge)", label: "Every edge, hidden ones too" }] };
    case "overhang": return { rows: [
      { color: "var(--k-an-overhang-bed)", label: "On the bed" },
      { color: "var(--k-an-overhang-steep)", label: "Overhang over 45°: needs support" },
      { color: "var(--k-an-overhang-mild)", label: "Overhang 0–45°" },
      { color: "var(--k-an-overhang-neutral)", label: "Vertical or facing up" },
    ] };
    case "strain": return {
      ramp: { css: "var(--k-an-strain)", min: "0", mid: "half", max: "the limit" },
      rows: [{ color: "var(--k-an-strain-over)", label: "Over the material's limit" }, { color: "var(--k-an-strain-rigid)", label: "Rigid: no flexure here" }],
    };
  }
}

export interface ReadoutSpec { label: string; value: string; title?: string; state?: "ok" | "bad" }

/** What the Strain lens reads out: the flexure working hardest, or that there are none. */
export interface StrainSummary {
  /** Flexures and beams in the model (0: not a compliant mechanism). */
  count: number;
  /** The pose has not been read yet. */
  pending?: boolean;
  worst?: { name: string; strain: number; pct: number };
}

/** The strain readouts' input: how many flexures the model has, and the pose as read (undefined while it is being read). */
export function strainSummary(count: number, state: Pick<FlexureState, "flexures"> | undefined): StrainSummary {
  if (!count) return { count: 0 };
  if (!state) return { count, pending: true };
  const w = worstFlexure(state);
  return { count: state.flexures.length || count, ...(w ? { worst: { name: w.name, strain: w.strain, pct: w.pct } } : {}) };
}

const STRAIN_SOURCE = "From the flexure model: each hinge as a small-length flexural pivot, each beam by a large-deflection beam solve; an estimate, not a finite-element result";

/** The readouts the HUD shows for a mode. */
export function readoutsFor(mode: LensMode, a: AnalysisParams, o: { bodiesInside: number; orient: Orient; hasCurvature: boolean; strain?: StrainSummary; support?: { steep: number; total: number } }): ReadoutSpec[] {
  switch (mode) {
    case "xray": return [{ label: "Bodies under the lens", value: String(o.bodiesInside), title: "Counted by each body's bounds centre" }];
    case "overhang": return [
      { label: "Orientation", value: ORIENTS.find((x) => x.key === o.orient)?.label ?? o.orient, title: "Faces are coloured by their angle to the build direction" },
      ...(o.support && o.support.total > 0 ? [{
        label: "Needs support", value: o.support.steep > 0 ? `${areaText(o.support.steep)} · ${Math.max(1, Math.round((100 * o.support.steep) / o.support.total))}%` : "none",
        title: "The area of the faces overhanging more than 45° in this orientation, and its share of the whole surface: summed over the display mesh, so an estimate",
        state: o.support.steep > 0 ? ("bad" as const) : ("ok" as const),
      }] : []),
    ];
    case "draft": return [{ label: "Draft angle", value: `${a.draftDeg}°` }, { label: "Pull", value: `${a.pull.x}, ${a.pull.y}, ${a.pull.z}` }];
    case "zebra": return [{ label: "Stripes", value: String(a.stripes) }];
    case "curvature": return [{ label: "Quantity", value: a.quantity }, ...(o.hasCurvature ? [] : [{ label: "Data", value: "none yet", title: "Curvature is being computed for the lens (or turn on Analysis ▸ Curvature / Combs); it appears when the backend answers" }])];
    case "strain": {
      const s = o.strain;
      if (!s || s.count === 0) return [{ label: "Flexures", value: "none in this model", title: "Strain shows on compliant mechanisms: flexure hinges and beam elements" }];
      if (s.pending || !s.worst) return [{ label: "Flexures", value: String(s.count) }, { label: "Strain", value: "reading…" }];
      const w = s.worst, bad = w.pct > 100;
      return [
        { label: "Worst flexure", value: w.name, title: STRAIN_SOURCE },
        { label: "Peak strain", value: `${(w.strain * 100).toFixed(2)}%`, title: STRAIN_SOURCE },
        { label: "Of its limit", value: Number.isFinite(w.pct) ? `${Math.round(w.pct)}%` : "no limit", state: bad ? "bad" : "ok", title: "Peak strain as a share of the material's allowable strain" },
      ];
    }
  }
}

// ---- state ----

export interface LensActions {
  setMode: (m: LensMode) => void;
  setShape: (s: LensShape) => void;
  setSize: (s: LensSize) => void;
  setOrient: (o: Orient) => void;
  moveTo: (p: { x: number; y: number; wipeX: number }) => void;
}

export const DEFAULT_LENS: LensState = { mode: "zebra", shape: "lens", size: "M", x: -1, y: -1, wipeX: -1, orient: "standing" };

export const useLens = create<LensState & LensActions>((set) => ({
  ...DEFAULT_LENS,
  setMode: (mode) => set({ mode }),
  setShape: (shape) => set({ shape }),
  setSize: (size) => set({ size }),
  setOrient: (orient) => set({ orient }),
  moveTo: (p) => set(p),
}));

/** Keyboard nudge for the handle: arrow keys move the lens by `step` px, screen y down (null for any other key). */
export function arrowDelta(key: string, step = 10): Pt | null {
  const a = arrowDir(key);
  return a ? { x: a.dx * step, y: (0 - a.dy) * step } : null;
}

/** The bounds centres of the built bodies, for counting bodies under the lens. */
export function bodyCentres(solids: Record<string, Pick<SolidEval, "mesh" | "bounds">>): { x: number; y: number; z: number }[] {
  return Object.values(solids).filter((s) => s.mesh && s.bounds).map((s) => boundsCentre(s.bounds!));
}

/** Whether any body carries curvature data (the store's analysisData is keyed by body). */
export function hasCurvature(analysisData: Record<string, unknown>): boolean {
  return Object.keys(analysisData).length > 0;
}
