// Reading back what src/core/export/threemf.ts writes, for the tests: the
// entries of a stored (uncompressed) zip, and the mesh objects of a 3MF model.

export function readStoredZip(bytes: Uint8Array): Record<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder();
  const out: Record<string, string> = {};
  let o = 0;
  while (o + 4 <= bytes.length && dv.getUint32(o, true) === 0x04034b50) {
    if (dv.getUint16(o + 8, true) !== 0) throw new Error("compressed entry");
    const size = dv.getUint32(o + 18, true), nameLen = dv.getUint16(o + 26, true), extra = dv.getUint16(o + 28, true);
    const name = dec.decode(bytes.subarray(o + 30, o + 30 + nameLen));
    out[name] = dec.decode(bytes.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + size));
    o += 30 + nameLen + extra + size;
  }
  return out;
}

export interface MeshObject { id: number; name: string; vertices: number[]; triangles: number[]; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

export function modelObjects(xml: string): MeshObject[] {
  const out: MeshObject[] = [];
  for (const m of xml.matchAll(/<object id="(\d+)"[^>]*name="([^"]*)"[^>]*><mesh>([\s\S]*?)<\/mesh>/g)) {
    const vertices = [...m[3].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap((v) => [+v[1], +v[2], +v[3]]);
    const triangles = [...m[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap((t) => [+t[1], +t[2], +t[3]]);
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < vertices.length; i += 3) {
      min.x = Math.min(min.x, vertices[i]); min.y = Math.min(min.y, vertices[i + 1]); min.z = Math.min(min.z, vertices[i + 2]);
      max.x = Math.max(max.x, vertices[i]); max.y = Math.max(max.y, vertices[i + 1]); max.z = Math.max(max.z, vertices[i + 2]);
    }
    out.push({ id: +m[1], name: m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"), vertices, triangles, min, max });
  }
  return out;
}

/** Edges not shared by exactly one other triangle running the other way: 0
 *  for a closed, consistently wound mesh. */
export function openEdges(o: MeshObject): number {
  const count = new Map<string, number>();
  for (let t = 0; t < o.triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = o.triangles[t + k], b = o.triangles[t + ((k + 1) % 3)];
      const key = `${a}>${b}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [key, n] of count) {
    const [a, b] = key.split(">");
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) open++;
  }
  return open;
}
