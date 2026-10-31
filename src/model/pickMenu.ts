// The long-press selection picker (Fusion's "select other"): everything along the
// ray under the cursor, nearest first, so a face hidden behind the model (or
// behind a panel) can still be chosen. Pure: what the entries are and which
// triangles light up while one is hovered; the store opens the menu and acts on
// the choice exactly as clicking that face would.

import type { CadDocument } from "../core/document";
import type { SolidEval } from "../core/features";
import { pickFace } from "../core/geometry/pick";
import { PLANES } from "../geometry/plane";

type P3 = { x: number; y: number; z: number };

export type PickItem =
  | { kind: "face"; bodyId: string; faceName?: string; point: P3; normal: P3; label: string; detail: string }
  | { kind: "plane"; planeId: string; point: P3; label: string; detail: string };

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
      label: `${feature?.name ?? "Body"}${part ? ` · ${part}` : ""}`,
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
