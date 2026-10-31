// The tutorial's running project, a phone stand, as data and steps. The video
// director plays these steps (through the app's own store.dispatch, beside real
// UI input), and test/tutorialStand.test.ts builds the same stand in Node, so a
// change that breaks the video's model fails a test first.
//
// Layout (mm, Z up): a base box centred on the origin; on its +X side face, the
// side profile of a back plate leaning back (toward +Y) and of a lip in front
// of the phone, each extruded across the base and joined. The lip's distance
// from the plate is `phone + 2`, a sketch dimension, so it follows the phone.

import type { CadDocument } from "../core/document";

export const STAND = {
  width: 90, depth: 70, base: 6, // the base box
  plate: 8, height: 62, angle: 65, // back plate: horizontal thickness, height above the base, lean from horizontal (deg)
  plateFront: -4, // y of the plate's front-bottom edge
  phone: 9, lipT: 4, lipH: 10, // phone thickness, lip thickness and height
};
export type StandSize = typeof STAND;

type Pt = { x: number; y: number };
export interface StandHost {
  dispatch(type: string, params: Record<string, unknown>): Promise<{ ok: boolean; createdIds: string[]; error?: string; message?: string }>;
  doc(): CadDocument;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** The back plate's side outline in world (y, z): front-bottom, back-bottom, back-top, front-top. */
export function backOutline(s: StandSize = STAND): { y: number; z: number }[] {
  const run = s.height / Math.tan(rad(s.angle));
  const y0 = s.plateFront, z0 = s.base, z1 = s.base + s.height;
  return [{ y: y0, z: z0 }, { y: y0 + s.plate, z: z0 }, { y: y0 + s.plate + run, z: z1 }, { y: y0 + run, z: z1 }];
}

/** The lip's side outline in world (y, z): its back face sits `phone + 2` in front of the plate. */
export function lipOutline(s: StandSize = STAND): { y: number; z: number }[] {
  const back = s.plateFront - (s.phone + 2), front = back - s.lipT;
  return [{ y: front, z: s.base }, { y: back, z: s.base }, { y: back, z: s.base + s.lipH }, { y: front, z: s.base + s.lipH }];
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

/** The back plate's outline on a side sketch (one closed polyline). */
export async function backProfile(h: StandHost, sketchId: string, s: StandSize = STAND) {
  const pts = backOutline(s).map((p) => sideToUV(h.doc(), sketchId, p, s.width / 2));
  const r = await h.dispatch("sketch.addPolyline", { sketch: sketchId, points: pts, closed: true });
  if (!r.ok) throw new Error(`back profile: ${r.error}`);
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

/** Pin a lip rectangle (however it was drawn) with dimensions so its back face stays `phoneExpr + 2` in front of the
 *  plate: the corners are found by position, front-bottom, back-bottom and back-top. */
export async function dimensionLip(h: StandHost, sketchId: string, phoneExpr: string, s: StandSize = STAND) {
  const sk = h.doc().sketches[sketchId];
  const pts = Object.values(sk.entities).filter((e) => e.kind === "point" && e.id !== sk.originPointId) as { id: string; x: number; y: number }[];
  if (pts.length < 4) throw new Error("the lip sketch has no rectangle");
  const minU = Math.min(...pts.map((p) => p.x)), maxU = Math.max(...pts.map((p) => p.x)), minV = Math.min(...pts.map((p) => p.y)), maxV = Math.max(...pts.map((p) => p.y));
  const at = (u: number, v: number) => pts.reduce((b, p) => (Math.hypot(p.x - u, p.y - v) < Math.hypot(b.x - u, b.y - v) ? p : b)).id;
  const p0 = at(minU, minV), p1 = at(maxU, minV), p2 = at(maxU, maxV);
  const dims: Record<string, unknown>[] = [
    { type: "distanceX", a: p1, b: sk.originPointId, expression: `${phoneExpr} + 2 + ${-s.plateFront}` }, // the plate's front is at y = plateFront
    { type: "distanceY", a: sk.originPointId, b: p1, expression: String(s.base) },
    { type: "distanceX", a: p0, b: p1, expression: String(s.lipT) },
    { type: "distanceY", a: p1, b: p2, expression: String(s.lipH) },
  ];
  for (const d of dims) {
    const k = await h.dispatch("sketch.addDimension", { sketch: sketchId, ...d });
    if (!k.ok) throw new Error(`lip dimension: ${k.error}`);
  }
}

/** Extrude a side sketch across the base, joined to it (the face's normal is +X, so across is negative). */
export async function across(h: StandHost, sketchId: string, s: StandSize = STAND, distance = String(-s.width)) {
  const r = await h.dispatch("feature.extrude", { sketch: sketchId, distance, operation: "join" });
  if (!r.ok) throw new Error(`extrude: ${r.error}`);
  return r.createdIds[0];
}
