// Weldments: structural members laid along the lines of a layout sketch. The
// pure part — standard profile cross-sections, member frames along their lines,
// the joints where members meet, and the cut list — lives here; the solids are
// built in features.ts on the kernel.

import type { Vec3 } from "../math/vec";
import type { Sketch, SketchPoint } from "../sketch/types";
import { WorkPlane, to3d } from "../geometry/plane";
import type { Loop, LoopSegment, Profile, Pt } from "./geometry/profile";

export type ProfileKind = "rect_tube" | "square_tube" | "round_tube" | "round_bar" | "angle" | "channel" | "ibeam" | "flat" | "custom";

/** Resolved profile dimensions (mm): w width, h height, t wall/flange thickness, d diameter. */
export interface ProfileDims { kind: ProfileKind; w: number; h: number; t: number; d: number }

const loopOf = (pts: Pt[]): Loop => {
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p.x * q.y - q.x * p.y; }
  const segments: LoopSegment[] = pts.slice(1).map((to) => ({ kind: "line", to }));
  segments.push({ kind: "line", to: pts[0] });
  return { start: pts[0], segments, area: area / 2 };
};
const circleLoop = (r: number): Loop => ({ start: { x: r, y: 0 }, segments: [], circle: { center: { x: 0, y: 0 }, r }, area: Math.PI * r * r });
const rect = (w: number, h: number) => loopOf([{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]);
/** A polygon given in a w×h box from (0,0), re-centred on its box. */
const centred = (pts: Pt[], w: number, h: number) => loopOf(pts.map((p) => ({ x: p.x - w / 2, y: p.y - h / 2 })));

/** The cross-section of a standard profile, centred on the member's axis (x across, y up). */
export function standardProfile(p: ProfileDims): Profile {
  const { w, h, t, d } = p;
  const need = (ok: boolean, what: string) => { if (!ok) throw new Error(`${p.kind.replace("_", " ")} needs ${what}`); };
  switch (p.kind) {
    case "rect_tube": case "square_tube": {
      const H = p.kind === "square_tube" ? w : h;
      need(w > 0 && H > 0 && t > 0 && 2 * t < Math.min(w, H), "width, height and a wall thinner than half of each");
      return { outer: rect(w, H), holes: [rect(w - 2 * t, H - 2 * t)] };
    }
    case "round_tube":
      need(d > 0 && t > 0 && 2 * t < d, "a diameter and a wall thinner than its radius");
      return { outer: circleLoop(d / 2), holes: [circleLoop(d / 2 - t)] };
    case "round_bar":
      need(d > 0, "a diameter");
      return { outer: circleLoop(d / 2), holes: [] };
    case "flat":
      need(w > 0 && h > 0, "width and height");
      return { outer: rect(w, h), holes: [] };
    case "angle":
      need(w > t && h > t && t > 0, "legs longer than its thickness");
      return { outer: centred([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t }, { x: t, y: t }, { x: t, y: h }, { x: 0, y: h }], w, h), holes: [] };
    case "channel":
      need(w > t && h > 2 * t && t > 0, "flanges longer than its thickness and a web taller than two of them");
      return { outer: centred([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t }, { x: t, y: t }, { x: t, y: h - t }, { x: w, y: h - t }, { x: w, y: h }, { x: 0, y: h }], w, h), holes: [] };
    case "ibeam": {
      need(w > t && h > 2 * t && t > 0, "a flange wider than the web and a height over two flanges");
      const a = (w - t) / 2;
      return { outer: centred([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t }, { x: a + t, y: t }, { x: a + t, y: h - t }, { x: w, y: h - t }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: h - t }, { x: a, y: h - t }, { x: a, y: t }, { x: 0, y: t }], w, h), holes: [] };
    }
    case "custom":
      throw new Error("a custom profile comes from its sketch");
  }
}

/** A cut-list name for a profile, e.g. "Rect tube 40×20×2". */
export function profileLabel(p: ProfileDims): string {
  const f = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  switch (p.kind) {
    case "rect_tube": return `Rect tube ${f(p.w)}×${f(p.h)}×${f(p.t)}`;
    case "square_tube": return `Square tube ${f(p.w)}×${f(p.t)}`;
    case "round_tube": return `Round tube Ø${f(p.d)}×${f(p.t)}`;
    case "round_bar": return `Round bar Ø${f(p.d)}`;
    case "flat": return `Flat ${f(p.w)}×${f(p.h)}`;
    case "angle": return `Angle ${f(p.w)}×${f(p.h)}×${f(p.t)}`;
    case "channel": return `Channel ${f(p.w)}×${f(p.h)}×${f(p.t)}`;
    case "ibeam": return `I-beam ${f(p.w)}×${f(p.h)}×${f(p.t)}`;
    case "custom": return "Custom profile";
  }
}

/** Half the diagonal of a profile's bounding box: how far it reaches from the axis. */
export function profileReach(pr: Profile): number {
  const loop = pr.outer;
  if (loop.circle) return loop.circle.r;
  let r = Math.hypot(loop.start.x, loop.start.y);
  for (const s of loop.segments) {
    r = Math.max(r, Math.hypot(s.to.x, s.to.y));
    if (s.kind === "arc") r = Math.max(r, Math.hypot(s.via.x, s.via.y));
    if (s.kind === "spline") for (const p of s.through) r = Math.max(r, Math.hypot(p.x, p.y));
  }
  return r;
}

/** How far a profile, turned by `rotate` (radians), reaches across its x axis
 *  (the direction in the layout plane, across the member): where a member
 *  butting into it stops. */
export function profileHalfWidth(pr: Profile, rotate = 0): number {
  const c = Math.cos(rotate), s = Math.sin(rotate);
  const loop = pr.outer;
  if (loop.circle) return loop.circle.r;
  const pts: Pt[] = [loop.start, ...loop.segments.flatMap((g) => (g.kind === "arc" ? [g.to, g.via] : g.kind === "spline" ? g.through : [g.to]))];
  return Math.max(...pts.map((p) => Math.abs(p.x * c - p.y * s)));
}

/** One member: a layout line in world space, keyed by its end-point ids. */
export interface MemberLine { lineId: string; a: Vec3; b: Vec3; aKey: string; bKey: string }

/** The layout lines that become members (every non-construction line, or the listed ones). */
export function memberLines(sk: Sketch, plane: WorkPlane, lineIds?: string[]): MemberLine[] {
  const pt = (id: string) => sk.entities[id] as SketchPoint | undefined;
  const out: MemberLine[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.kind !== "line" || (lineIds ? !lineIds.includes(e.id) : e.construction)) continue;
    const p = pt(e.p1), q = pt(e.p2);
    if (!p || !q || Math.hypot(q.x - p.x, q.y - p.y) < 1e-9) continue;
    out.push({ lineId: e.id, a: to3d(plane, p.x, p.y), b: to3d(plane, q.x, q.y), aKey: e.p1, bKey: e.p2 });
  }
  return out;
}

export interface JointEnd { member: number; end: "a" | "b" }
/** Where members meet: shared end points (by point id, or coincident within 1e-6). */
export function memberJoints(members: MemberLine[]): { at: Vec3; ends: JointEnd[] }[] {
  const joints: { at: Vec3; keys: Set<string>; ends: JointEnd[] }[] = [];
  members.forEach((m, i) => {
    for (const end of ["a", "b"] as const) {
      const p = m[end], key = end === "a" ? m.aKey : m.bKey;
      const j = joints.find((x) => x.keys.has(key) || Math.hypot(x.at.x - p.x, x.at.y - p.y, x.at.z - p.z) < 1e-6);
      if (j) { j.keys.add(key); j.ends.push({ member: i, end }); }
      else joints.push({ at: p, keys: new Set([key]), ends: [{ member: i, end }] });
    }
  });
  return joints.map(({ at, ends }) => ({ at, ends }));
}

/** A cut-list row: identical pieces (same profile, cut length to 0.1 mm, end angles to 0.5°) grouped. */
export interface CutListRow { profile: string; length: number; angles: [number, number]; quantity: number; bodies: string[] }

export function groupCutList(pieces: { body: string; profile: string; length: number; angles: [number, number] }[]): CutListRow[] {
  const rows = new Map<string, CutListRow>();
  for (const p of pieces) {
    const length = Math.round(p.length * 10) / 10;
    const angles = [...p.angles].map((a) => Math.round(a * 2) / 2).sort((x, y) => x - y) as [number, number];
    const key = `${p.profile}|${length}|${angles.join(",")}`;
    const row = rows.get(key);
    if (row) { row.quantity++; row.bodies.push(p.body); }
    else rows.set(key, { profile: p.profile, length, angles, quantity: 1, bodies: [p.body] });
  }
  return [...rows.values()].sort((a, b) => a.profile.localeCompare(b.profile) || b.length - a.length);
}

/** The cut list as CSV (profile, length mm, end angles °, quantity). */
export function cutListCsv(rows: CutListRow[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["Profile,Length (mm),Angle A (°),Angle B (°),Qty", ...rows.map((r) => [q(r.profile), r.length, r.angles[0], r.angles[1], r.quantity].join(","))].join("\n") + "\n";
}
