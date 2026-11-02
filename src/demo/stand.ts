// The tutorial's running project, a phone stand, as data and steps. The video
// director plays these steps (through the app's own store.dispatch, beside real
// UI input), and test/tutorialStand.test.ts builds the same stand in Node, so a
// change that breaks the video's model fails a test first.
//
// Layout (mm, Z up): a base box centred on the origin; on its +X side face, the
// side profile of a back plate leaning back (toward +Y) and of a lip in front
// of the phone, each extruded across the base and joined. Once parametric, the
// slot between plate and lip is `phone + 2` wide about a fixed middle (so the
// phone's weight stays over the base): a thicker phone moves the plate back and
// the lip forward by half each, and the lip stands `phone + 1` tall to hold it.
// All of it is sketch dimensions written as formulas.

import type { CadDocument } from "../core/document";

export const STAND = {
  width: 90, depth: 70, base: 6, // the base box
  plate: 8, height: 62, angle: 65, // back plate: horizontal thickness, height above the base, lean from horizontal (deg)
  slot: -9.5, // y of the middle of the slot the phone stands in, between the plate and the lip
  phone: 9, lipT: 4, // phone thickness, lip thickness (the lip is phone + 1 tall)
};
export type StandSize = typeof STAND;

type Pt = { x: number; y: number };
export interface StandHost {
  dispatch(type: string, params: Record<string, unknown>): Promise<{ ok: boolean; createdIds: string[]; error?: string; message?: string }>;
  doc(): CadDocument;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** y of the plate's front-bottom edge: half the slot (phone + 2) behind its middle. */
export const plateFront = (s: StandSize = STAND) => s.slot + (s.phone + 2) / 2;
/** The lip's height: a millimetre more than the phone is thick. */
export const lipHeight = (s: StandSize = STAND) => s.phone + 1;

/** The back plate's side outline in world (y, z): front-bottom, back-bottom, back-top, front-top. */
export function backOutline(s: StandSize = STAND): { y: number; z: number }[] {
  const run = s.height / Math.tan(rad(s.angle));
  const y0 = plateFront(s), z0 = s.base, z1 = s.base + s.height;
  return [{ y: y0, z: z0 }, { y: y0 + s.plate, z: z0 }, { y: y0 + s.plate + run, z: z1 }, { y: y0 + run, z: z1 }];
}

/** The lip's side outline in world (y, z): its back face sits `phone + 2` in front of the plate. */
export function lipOutline(s: StandSize = STAND): { y: number; z: number }[] {
  const back = plateFront(s) - (s.phone + 2), front = back - s.lipT, h = lipHeight(s);
  return [{ y: front, z: s.base }, { y: back, z: s.base }, { y: back, z: s.base + h }, { y: front, z: s.base + h }];
}

/** World (y, z) on the +X side face → that face sketch's (u, v). */
export function sideToUV(doc: CadDocument, sketchId: string, p: { y: number; z: number }, x: number): Pt {
  const pl = doc.sketches[sketchId].plane!;
  const d = { x: x - pl.origin.x, y: p.y - pl.origin.y, z: p.z - pl.origin.z };
  return { x: d.x * pl.u.x + d.y * pl.u.y + d.z * pl.u.z, y: d.x * pl.v.x + d.y * pl.v.y + d.z * pl.v.z };
}

/** A sketch on the base's +X side face, as clicking the face and pressing S makes it. */
export async function sideSketch(h: StandHost, s: StandSize = STAND): Promise<string> {
  const x = s.width / 2;
  const r = await h.dispatch("sketch.create", { planeDef: { origin: { x, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }, faceRef: { normal: { x: 1, y: 0, z: 0 }, point: { x, y: 0, z: s.base / 2 } } });
  if (!r.ok) throw new Error(`side sketch: ${r.error}`);
  return r.createdIds[0];
}

export async function box(h: StandHost, s: StandSize = STAND) {
  const r = await h.dispatch("feature.primitive", { shape: "box", x: String(s.width), y: String(s.depth), z: String(s.base), at: { x: 0, y: 0, z: s.base / 2 }, name: "Base" });
  if (!r.ok) throw new Error(`box: ${r.error}`);
  return r.createdIds[0];
}

/** The back plate's outline on a side sketch (one closed polyline). With `phoneExpr`, dimensions pin it so it
 *  stands half of `phoneExpr + 2` behind the slot's middle: change the phone and the plate moves back. */
export async function backProfile(h: StandHost, sketchId: string, s: StandSize = STAND, phoneExpr?: string) {
  const pts = backOutline(s).map((p) => sideToUV(h.doc(), sketchId, p, s.width / 2));
  const r = await h.dispatch("sketch.addPolyline", { sketch: sketchId, points: pts, closed: true });
  if (!r.ok) throw new Error(`back profile: ${r.error}`);
  if (phoneExpr) await dimensionBack(h, sketchId, phoneExpr, s);
  return pts;
}

/** The lip's rectangle on its own side sketch. With `phoneExpr` (a parameter name or formula), dimensions pin it so
 *  its back face stays `phoneExpr + 2` in front of the plate: change the phone and the lip follows. */
export async function lipProfile(h: StandHost, sketchId: string, s: StandSize = STAND, phoneExpr?: string) {
  const [a, , c] = lipOutline(s).map((p) => sideToUV(h.doc(), sketchId, p, s.width / 2));
  const r = await h.dispatch("sketch.addRectangle", { sketch: sketchId, corner: a, opposite: c });
  if (!r.ok) throw new Error(`lip: ${r.error}`);
  if (phoneExpr) await dimensionLip(h, sketchId, phoneExpr, s);
  return r.createdIds;
}

/** Pin a lip rectangle (however it was drawn) with dimensions so its back face sits half of `phoneExpr + 2` in front
 *  of the slot's middle and it stands `phoneExpr + 1` tall: the corners are found by position, front-bottom,
 *  back-bottom and back-top. */
export async function dimensionLip(h: StandHost, sketchId: string, phoneExpr: string, s: StandSize = STAND) {
  const sk = h.doc().sketches[sketchId];
  const pts = Object.values(sk.entities).filter((e) => e.kind === "point" && e.id !== sk.originPointId) as { id: string; x: number; y: number }[];
  if (pts.length < 4) throw new Error("the lip sketch has no rectangle");
  const minU = Math.min(...pts.map((p) => p.x)), maxU = Math.max(...pts.map((p) => p.x)), minV = Math.min(...pts.map((p) => p.y)), maxV = Math.max(...pts.map((p) => p.y));
  const at = (u: number, v: number) => pts.reduce((b, p) => (Math.hypot(p.x - u, p.y - v) < Math.hypot(b.x - u, b.y - v) ? p : b)).id;
  const p0 = at(minU, minV), p1 = at(maxU, minV), p2 = at(maxU, maxV);
  const dims: Record<string, unknown>[] = [
    { type: "distanceX", a: p1, b: sk.originPointId, expression: `${-s.slot} + (${phoneExpr} + 2) / 2` }, // half the slot in front of its middle
    { type: "distanceY", a: sk.originPointId, b: p1, expression: String(s.base) },
    { type: "distanceX", a: p0, b: p1, expression: String(s.lipT) },
    { type: "distanceY", a: p1, b: p2, expression: `${phoneExpr} + 1` },
  ];
  for (const d of dims) {
    const k = await h.dispatch("sketch.addDimension", { sketch: sketchId, ...d });
    if (!k.ok) throw new Error(`lip dimension: ${k.error}`);
  }
}

/** Pin the back plate's outline (however it was drawn) with dimensions so its front sits half of `phoneExpr + 2`
 *  behind the slot's middle, the plate keeping its thickness, height and lean: the corners are found by where the
 *  outline put them. Its bottom and top edges are held level (unless drawing them level already did). */
export async function dimensionBack(h: StandHost, sketchId: string, phoneExpr: string, s: StandSize = STAND) {
  const sk = h.doc().sketches[sketchId];
  const pts = Object.values(sk.entities).filter((e) => e.kind === "point" && e.id !== sk.originPointId) as { id: string; x: number; y: number }[];
  if (pts.length < 4) throw new Error("the back plate's sketch has no outline");
  const at = (q: Pt) => pts.reduce((b, p) => (Math.hypot(p.x - q.x, p.y - q.y) < Math.hypot(b.x - q.x, b.y - q.y) ? p : b)).id;
  const [p0, p1, p2, p3] = backOutline(s).map((q) => at(sideToUV(h.doc(), sketchId, q, s.width / 2))); // front-bottom, back-bottom, back-top, front-top
  const level = (a: string, b: string) => Object.values(sk.constraints as Record<string, { type: string; a?: string; b?: string }>).some((c) => c.type === "horizontal" && ((c.a === a && c.b === b) || (c.a === b && c.b === a)));
  for (const [a, b] of [[p0, p1], [p3, p2]]) {
    if (level(a, b)) continue;
    const k = await h.dispatch("sketch.addConstraint", { sketch: sketchId, type: "horizontal", a, b });
    if (!k.ok) throw new Error(`back plate constraint: ${k.error}`);
  }
  const run = `${s.height} / tan(rad(${s.angle}))`;
  const dims: Record<string, unknown>[] = [
    { type: "distanceX", a: p0, b: sk.originPointId, expression: `${-s.slot} - (${phoneExpr} + 2) / 2` }, // half the slot behind its middle
    { type: "distanceY", a: sk.originPointId, b: p0, expression: String(s.base) },
    { type: "distanceX", a: p0, b: p1, expression: String(s.plate) },
    { type: "distanceX", a: p0, b: p3, expression: run },
    { type: "distanceY", a: p0, b: p3, expression: String(s.height) },
    { type: "distanceX", a: p3, b: p2, expression: String(s.plate) },
  ];
  for (const d of dims) {
    const k = await h.dispatch("sketch.addDimension", { sketch: sketchId, ...d });
    if (!k.ok) throw new Error(`back plate dimension: ${k.error}`);
  }
}

/** The base's far (−X) side face, as a "to face" extrude target. */
export const farSide = (s: StandSize = STAND) => ({ normal: { x: -1, y: 0, z: 0 }, point: { x: -s.width / 2, y: -s.depth / 2 + 8, z: s.base / 2 } });

/** Extrude a side sketch across the base, joined to it: to the far side face (`distance` "toFace"), or by a distance
 *  (the face's normal is +X, so across is negative). */
export async function across(h: StandHost, sketchId: string, s: StandSize = STAND, distance = "toFace") {
  const r = await h.dispatch("feature.extrude", distance === "toFace"
    ? { sketch: sketchId, distance: "0", operation: "join", extent: "toFace", toFace: farSide(s) }
    : { sketch: sketchId, distance, operation: "join" });
  if (!r.ok) throw new Error(`extrude: ${r.error}`);
  return r.createdIds[0];
}
