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
];
export const SHAPES: { key: LensShape; label: string }[] = [{ key: "lens", label: "Lens" }, { key: "wipe", label: "Wipe" }];
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

/** Where the HUD card sits: off the circle's right rim, or beside the wipe line's top; flipped and clamped inside. */
export function hudPlacement(f: LensFrame, card: Box, bounds: Box): Pt {
  if (f.shape === "lens") return placeCard({ anchor: { x: f.x + f.r, y: f.y - f.r * 0.5 }, size: card, bounds, prefer: "right", gap: 16 });
  return placeCard({ anchor: { x: f.wipeX, y: 12 }, size: card, bounds, prefer: "right", gap: 12 });
}

export { clampInside };

export interface AnalysisParams {
  stripes: number;
  draftDeg: number;
  pull: { x: number; y: number; z: number };
  quantity: "mean" | "gaussian" | "max" | "min";
}

/** The spec the 3D pass renders from. */
export function toLensSpec(s: Pick<LensState, "mode" | "orient">, f: LensFrame, a: AnalysisParams): LensSpec {
  return { mode: s.mode, shape: f.shape, x: f.x, y: f.y, r: f.r, wipeX: f.wipeX, up: orientUp(s.orient), stripes: a.stripes, draftDeg: a.draftDeg, pull: a.pull, quantity: a.quantity };
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
  }
}

export interface ReadoutSpec { label: string; value: string; title?: string }

/** The readouts the HUD shows for a mode. */
export function readoutsFor(mode: LensMode, a: AnalysisParams, o: { bodiesInside: number; orient: Orient; hasCurvature: boolean }): ReadoutSpec[] {
  switch (mode) {
    case "xray": return [{ label: "Bodies under the lens", value: String(o.bodiesInside), title: "Counted by each body's bounds centre" }];
    case "overhang": return [{ label: "Orientation", value: ORIENTS.find((x) => x.key === o.orient)?.label ?? o.orient, title: "Faces are coloured by their angle to the build direction; a face count would need the B-rep, so none is shown" }];
    case "draft": return [{ label: "Draft angle", value: `${a.draftDeg}°` }, { label: "Pull", value: `${a.pull.x}, ${a.pull.y}, ${a.pull.z}` }];
    case "zebra": return [{ label: "Stripes", value: String(a.stripes) }];
    case "curvature": return [{ label: "Quantity", value: a.quantity }, ...(o.hasCurvature ? [] : [{ label: "Data", value: "none yet", title: "Curvature is being computed for the lens (or turn on Analysis ▸ Curvature / Combs); it appears when the backend answers" }])];
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
