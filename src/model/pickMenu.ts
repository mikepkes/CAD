// The long-press selection picker (Fusion's "select other"): everything along the
// ray under the cursor, nearest first, so a face hidden behind the model (or
// behind a panel) can still be chosen. Pure: what the entries are and which
// triangles light up while one is hovered; the store opens the menu and acts on
// the choice exactly as clicking that face would.

import type { CadDocument } from "../core/document";
import type { SolidEval } from "../core/features";
import { pickFace } from "../core/geometry/pick";
import { PLANES } from "../geometry/plane";
import type { Sketch } from "../sketch/types";

type P3 = { x: number; y: number; z: number };

export type PickItem =
  | { kind: "face"; bodyId: string; faceName?: string; point: P3; normal: P3; label: string; detail: string }
  | { kind: "plane"; planeId: string; point: P3; label: string; detail: string }
  | { kind: "entity"; id: string; label: string; detail: string };

/** A sketch entity as the picker lists it: "Point", "Line, horizontal, 40 mm", "Circle ⌀ 10 mm", "Dimension 40". */
export function entityLabel(sk: Sketch, id: string): string {
  const e = sk.entities[id];
  const r = (v: number) => Math.round(v * 10) / 10;
  if (!e) {
    const c = sk.constraints[id] as { expr?: string } | undefined;
    return c?.expr != null ? `Dimension ${c.expr}` : "Constraint";
  }
  const cons = "construction" in e && e.construction ? "Construction " : "";
  if (e.kind === "point") return id === sk.originPointId ? "Origin" : "Point";
  if (e.kind === "line") {
    const a = sk.entities[e.p1], b = sk.entities[e.p2];
    if (a?.kind !== "point" || b?.kind !== "point") return `${cons}Line`;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const dir = Math.abs(dy) < 1e-6 * Math.max(1, len) ? "horizontal, " : Math.abs(dx) < 1e-6 * Math.max(1, len) ? "vertical, " : "";
    return `${cons}${cons ? "line" : "Line"}, ${dir}${r(len)} mm`;
  }
  if (e.kind === "circle") return `${cons}${cons ? "circle" : "Circle"} ⌀ ${r(2 * e.r)} mm`;
  if (e.kind === "arc") return `${cons}${cons ? "arc" : "Arc"} r ${r(e.r)} mm`;
  if (e.kind === "ellipse") return `${cons}${cons ? "ellipse" : "Ellipse"}`;
  return `${cons}${cons ? "spline" : "Spline"}`;
}

/** The picker's entries for a long press in a sketch: the entities under the cursor, points first. */
export function sketchPickItems(sk: Sketch, hits: { id: string }[], max = 8): PickItem[] {
  return hits.slice(0, max).map((h, i) => ({ kind: "entity", id: h.id, label: entityLabel(sk, h.id), detail: i === 0 ? "nearest" : `under it, ${i}` }));
}

/** Which way a face looks, in words: "top"/"bottom" (±Z), "+X"/"-X", "+Y"/"-Y", or null when it isn't square to an axis. */
export function orientationWord(n: P3): string | null {
  if (n.z > 0.9) return "top";
  if (n.z < -0.9) return "bottom";
  if (Math.abs(n.x) > 0.9) return n.x > 0 ? "+X" : "-X";
  if (Math.abs(n.y) > 0.9) return n.y > 0 ? "+Y" : "-Y";
  return null;
}

/** A face as a person would name it (M19): which way it looks and what part it is ("top", "+X end", "curved side",
 *  "rounded edge"), never the topology's internal names ("side:ln5", "blend(…)"). */
export function faceLabel(part: string, normal: P3): string {
  const way = orientationWord(normal);
  const kind = part.split(":")[0].replace(/@\d+$/, "").replace(/#\d+$/, "");
  if (kind === "end" || kind === "start") return way ? (way === "top" || way === "bottom" ? `${way} (${kind})` : `${way} ${kind}`) : `${kind} face`;
  if (kind === "side" || kind === "rev") return way ? (way === "top" || way === "bottom" ? way : `${way} side`) : "curved side";
  if (/^blend/.test(kind)) return "rounded edge";
  if (/^chamfer/.test(kind)) return "bevelled edge";
  if (/^inner/.test(kind)) return way ? `inside, ${way}` : "inside face";
  if (kind === "bore") return "hole wall";
  if (/^[+-][XYZ]$/.test(kind) || !kind) return way ?? "face";
  return way ? `${way} face` : "face";
}

/** The picker's entries for the ray hits: one per distinct face (named by the feature that made it), then the planes. */
export function pickItems(
  hits: { faces: { bodyId: string; world: P3; normal: P3 }[]; planes: { planeId: string; world: P3 }[] },
  solids: Record<string, SolidEval>,
  doc: CadDocument,
  max = 8,
): PickItem[] {
  const meshes = Object.values(solids).filter((s) => s.mesh).map((s) => ({ featureId: s.featureId, mesh: s.mesh! }));
  const seen = new Set<string>();
  const out: PickItem[] = [];
  for (const h of hits.faces) {
    const named = pickFace(meshes.filter((m) => m.featureId === h.bodyId), h.world) ?? pickFace(meshes, h.world);
    const key = `${h.bodyId}|${named?.faceName ?? `${h.normal.x.toFixed(2)},${h.normal.y.toFixed(2)},${h.normal.z.toFixed(2)}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [fid, part] = named?.faceName?.includes(":") ? named.faceName.split(":", 2) : [h.bodyId, ""];
    const feature = doc.features[fid] as { name?: string } | undefined;
    const n = out.length;
    out.push({
      kind: "face", bodyId: h.bodyId, faceName: named?.faceName, point: h.world, normal: h.normal,
      label: `${feature?.name ?? "Body"} · ${faceLabel(part, h.normal)}`,
      detail: n === 0 ? "nearest" : `behind, ${n}`,
    });
  }
  for (const p of hits.planes) {
    if (seen.has(`plane|${p.planeId}`)) continue;
    seen.add(`plane|${p.planeId}`);
    const name = PLANES.find((q) => q.id === p.planeId)?.name ?? doc.planes[p.planeId]?.name ?? p.planeId;
    out.push({ kind: "plane", planeId: p.planeId, point: p.world, label: `${name} plane`, detail: "plane" });
  }
  return out.slice(0, max);
}

/** The world positions of one named face's triangles (flat xyz), for the hover highlight. */
export function faceTriangles(mesh: { positions: Float32Array; indices: Uint32Array; faceRanges?: number[]; faceNames?: string[] } | undefined, faceName: string | undefined): Float32Array | null {
  if (!mesh?.faceRanges || !mesh.faceNames || !faceName) return null;
  const k = mesh.faceNames.indexOf(faceName);
  if (k < 0) return null;
  const start = mesh.faceRanges[2 * k], count = mesh.faceRanges[2 * k + 1];
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = mesh.indices[start + i] * 3;
    out[i * 3] = mesh.positions[v]; out[i * 3 + 1] = mesh.positions[v + 1]; out[i * 3 + 2] = mesh.positions[v + 2];
  }
  return out;
}
