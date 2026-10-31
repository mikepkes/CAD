// What feature.gear needs besides the geometry: the numbers it takes, the
// checks that reject an impossible gear before anything is built, and `mesh`
// — the placement maths of core/geometry/gear.ts written out as expressions of
// the mate's own expressions, so a meshed pair stays meshed (centre distance
// and phase) when either gear's module, teeth, position or phase changes.

import type { GearDim, GearFeature, GearKind } from "./document";
import { gearOutline, bevelOutline, wormGeometry, gearDefaults } from "./geometry/gear";
import { compileExpr, Scope } from "../math/expr";

/** Every number feature.gear takes, in the order the card lists them. */
export const GEAR_DIMS: GearDim[] = [
  "module", "teeth", "faceWidth", "helixAngle", "pressureAngle", "backlash", "addendum", "dedendum", "rootFillet", "rim",
  "mateTeeth", "wormDiameter", "bore", "dFlat", "keyway", "keywayDepth", "hubDiameter", "hubLength", "spokes", "x", "y", "offset", "rotation",
];

export const GEAR_LABEL: Record<GearKind, string> = {
  spur: "Spur gear", helical: "Helical gear", herringbone: "Herringbone gear", ring: "Ring gear", rack: "Rack", bevel: "Bevel gear", worm: "Worm",
};

const ROUND: GearKind[] = ["spur", "helical", "herringbone"];

/** Reject a gear that can't be built (the profile maths throws with the reason). `v` holds the evaluated numbers given. */
export function checkGear(type: GearKind, v: Partial<Record<GearDim, number>>, herringbone: boolean): void {
  const m = v.module ?? 2, z = v.teeth ?? (type === "worm" ? 1 : 20);
  if (!(m > 0)) throw new Error("gear module must be positive");
  if (type === "worm") {
    if (!(z >= 1 && z <= 8 && Number.isInteger(z))) throw new Error("worm teeth (its number of starts) must be a whole number from 1 to 8");
  } else if (!(z >= 3 && Number.isInteger(z))) throw new Error("gear teeth must be a whole number, at least 3");
  const d = gearDefaults(type, m, z, v.mateTeeth ?? z);
  const get = (k: GearDim) => v[k] ?? (d as Record<string, number>)[k];
  if (!(get("faceWidth") > 0)) throw new Error("gear faceWidth must be positive");
  const helix = get("helixAngle");
  if ((type === "helical" || type === "herringbone" || type === "ring" || type === "rack") && !(Math.abs(helix) < 60)) throw new Error("helixAngle must be under 60°");
  if ((type === "helical" || type === "herringbone") && Math.abs(helix) < 1e-9) throw new Error(`a ${type} gear needs a helixAngle (use type spur for straight teeth)`);
  if (herringbone && type !== "ring" && type !== "rack") throw new Error("herringbone: true is for a ring or rack (use type herringbone for a round gear)");
  for (const k of ["bore", "dFlat", "keyway", "hubDiameter", "hubLength", "spokes", "backlash"] as GearDim[]) if (get(k) < 0) throw new Error(`gear ${k} must not be negative`);
  if (get("dFlat") > 0 && !(get("dFlat") < get("bore"))) throw new Error("dFlat (the D-shaft's across-flat size) must be smaller than the bore");
  if (get("keyway") > 0 && !(get("keyway") < get("bore"))) throw new Error("keyway must be narrower than the bore");
  const spec = { module: m, teeth: z, pressureAngle: get("pressureAngle"), addendum: get("addendum"), dedendum: get("dedendum"), backlash: get("backlash"), rootFillet: get("rootFillet") };
  let root = Infinity;
  if (type === "worm") root = wormGeometry(m, z, get("wormDiameter"), spec).rootRadius;
  else if (type === "bevel") root = bevelOutline({ ...spec, mateTeeth: get("mateTeeth") }).radii!.root;
  else if (type === "rack") gearOutline({ ...spec, type: "rack" });
  else if (type === "ring") gearOutline({ ...spec, type: "internal" });
  else root = gearOutline({ ...spec, type: "external" }).radii!.root;
  const boreR = get("bore") / 2 + (get("keyway") > 0 ? (v.keywayDepth ?? get("keyway") / 2) : 0);
  if (type !== "ring" && type !== "rack" && boreR > 0 && !(boreR < root - 0.5)) throw new Error(`the bore leaves no wall: keep it under ⌀${(2 * (root - 0.5)).toFixed(2)} (the root circle is ⌀${(2 * root).toFixed(2)})`);
}

/** A gear's expression for `k`: what it was given, else its default as text. */
function exprOf(g: GearFeature, k: GearDim): string {
  if (g.dims[k] != null) return g.dims[k]!;
  if (k === "module") return "2";
  if (k === "teeth") return g.gearType === "worm" ? "1" : "20";
  if (k === "helixAngle") return g.gearType === "helical" ? "20" : g.gearType === "herringbone" ? "30" : "0";
  return "0";
}

const isHerringbone = (type: GearKind, flag: boolean) => type === "herringbone" || flag;
const isTwisted = (type: GearKind) => type === "helical" || type === "herringbone" || type === "ring" || type === "rack";

/**
 * Placement of a new gear (`type`, its given `dims`) in mesh with `mate`, as expressions of the
 * mate's: x, y, rotation, and — when not given — module, offset and helixAngle. See the maths in
 * core/geometry/gear.ts (meshRotation, rackPinionRotation).
 */
export function gearMeshExprs(mate: GearFeature, type: GearKind, dims: Partial<Record<GearDim, string>>, mesh: { angle?: string | number; along?: string | number }, herringbone = false): { dims: Partial<Record<GearDim, string>>; note: string } {
  if (!ROUND.includes(type)) throw new Error(`mesh: places a spur, helical or herringbone gear (bevel and worm pairs: see the feature.gear description)`);
  const pair = ROUND.includes(mate.gearType) ? "external" : mate.gearType === "ring" ? "internal" : mate.gearType === "rack" ? "rack" : null;
  if (!pair) throw new Error(`mesh: can't mesh with a ${mate.gearType} — mesh with a spur, helical, herringbone, ring or rack gear`);
  if (isHerringbone(mate.gearType, !!mate.herringbone) !== isHerringbone(type, herringbone)) throw new Error("mesh: a herringbone gear only meshes with another herringbone");
  const out: Partial<Record<GearDim, string>> = {};
  const P = (e: string) => (/^[-+]?[\w.]+$/.test(e) ? e : `(${e})`);
  const m = P(dims.module ?? exprOf(mate, "module"));
  if (dims.module == null) out.module = exprOf(mate, "module");
  if (dims.offset == null && mate.dims.offset != null) out.offset = mate.dims.offset;
  const h1 = exprOf(mate, "helixAngle");
  if (dims.helixAngle == null && isTwisted(type) && isTwisted(mate.gearType)) out.helixAngle = pair === "external" ? (h1.startsWith("-") ? h1.slice(1) : `-${P(h1)}`) : h1;
  const z1 = P(exprOf(mate, "teeth")), z2 = P(dims.teeth ?? "20");
  const x1 = exprOf(mate, "x"), y1 = exprOf(mate, "y"), r1 = exprOf(mate, "rotation");
  const plus = (a: string, b: string) => (a === "0" ? b : `${a} + ${b}`);
  if (pair === "rack") {
    if (r1 !== "0") throw new Error("mesh: the rack must not be rotated (turn its sketch instead)");
    const along = String(mesh.along ?? 0);
    const c0 = `(1 - (${z1} - 2*floor(${z1}/2)))*pi*${m}/2`; // a rack tooth centre: the middle for an odd count, half a pitch along for even
    const q = `((${along}) - ${c0})/(pi*${m})`;
    out.x = plus(x1, P(along));
    out.y = plus(y1, `${m}*${z2}/2`);
    out.rotation = `-90 - (0.5 + ${q} - floor(${q}))*360/${z2}`;
    return { dims: out, note: ` — on rack ${mate.name}: it travels ${"π·module·teeth"}/360 per degree` };
  }
  const psi = P(String(mesh.angle ?? 0));
  const a = pair === "external" ? `${m}*(${z1} + ${z2})/2` : `${m}*(${z1} - ${z2})/2`;
  out.x = plus(x1, `${a}*cos(rad(${psi}))`);
  out.y = plus(y1, `${a}*sin(rad(${psi}))`);
  const t = `(${psi} - ${P(r1)})*${z1}/360`;
  const s = `(${t} - floor(${t}))`;
  out.rotation = pair === "external" ? `${psi} + 180 - (0.5 - ${s})*360/${z2}` : `${psi} - (0.5 + ${s})*360/${z2}`;
  return { dims: out, note: ` — meshed with ${mate.name} (${pair === "external" ? "it turns the other way" : "inside the ring, it turns the same way"}, teeth ratio ${z1}:${z2})` };
}

/** With `mesh`: the two gears' modules (and helix angles, when both twist) must match up. `v` is this gear's evaluated numbers. */
export function checkMesh(mate: GearFeature, type: GearKind, v: Partial<Record<GearDim, number>>, scope: Scope): void {
  const ev = (k: GearDim) => compileExpr(exprOf(mate, k)).eval(scope);
  if (Math.abs((v.module ?? 2) - ev("module")) > 1e-9) throw new Error(`mesh: module ${v.module} doesn't match ${mate.name}'s ${ev("module")} — gears only mesh at the same module`);
  // straight-cut gears have no helix; a mate needs the opposite hand (external) or the same (ring, rack)
  const h1 = isTwisted(mate.gearType) ? ev("helixAngle") : 0, h2 = isTwisted(type) ? (v.helixAngle ?? 0) : 0;
  const want = ROUND.includes(mate.gearType) ? -h1 : h1;
  if (Math.abs(h2 - want) > 1e-6) {
    throw new Error(want === 0
      ? `mesh: a ${type} gear won't mesh with ${mate.name}, a straight-cut ${mate.gearType} — use type spur`
      : `mesh: ${type === "spur" ? "a straight spur" : `helixAngle ${h2}°`} won't mesh with ${mate.name}'s ${h1}° helix — use helixAngle ${want}° (${ROUND.includes(mate.gearType) ? "the opposite hand" : "the same hand"})`);
  }
}
