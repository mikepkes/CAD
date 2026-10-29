// 3MF from meshes, for multi-material prints: ONE object made of several parts
// (a 3MF object of components), so a slicer loads them in place, together, and
// lets each part take its own filament (a PLA skeleton embedded in a TPU part).
// Each part is named after its material and carries its display colour.
// Dependency-free: the package is a zip of stored (uncompressed) entries, which
// the OPC container 3MF is built on allows.

export interface ThreeMfPart {
  name: string;
  /** "#rrggbb", shown by slicers that read 3MF base materials. */
  color?: string;
  positions: ArrayLike<number>; // flat x,y,z
  indices: ArrayLike<number>;   // triangle vertex indices
}

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (v: number) => String(Math.round(v * 1e5) / 1e5);

/** A display mesh splits its vertices per face (for normals); a print mesh must
 *  share them, or every edge is open. Merge vertices at the same spot (1e-5 mm)
 *  and drop the triangles that collapse. */
export function weld(positions: ArrayLike<number>, indices: ArrayLike<number>): { vertices: number[]; triangles: number[] } {
  const at = new Map<string, number>(), vertices: number[] = [], remap: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const key = `${fmt(x)},${fmt(y)},${fmt(z)}`;
    let k = at.get(key);
    if (k === undefined) { k = vertices.length / 3; at.set(key, k); vertices.push(x, y, z); }
    remap.push(k);
  }
  const triangles: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { vertices, triangles };
}

/** The 3D model part: base materials, one mesh object per part, and the object
 *  that gathers them, placed once on the build plate. */
export function modelXml(parts: ThreeMfPart[], name: string): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">`);
  out.push(`<metadata name="Application">Chisel CAD</metadata>`);
  out.push(`<metadata name="Title">${esc(name)}</metadata>`);
  out.push(`<resources>`);
  out.push(`<basematerials id="1">`);
  for (const p of parts) out.push(`<base name="${esc(p.name)}" displaycolor="${(p.color ?? "#cccccc").toUpperCase()}FF"/>`);
  out.push(`</basematerials>`);
  parts.forEach((p, i) => {
    const { vertices, triangles } = weld(p.positions, p.indices);
    out.push(`<object id="${i + 2}" type="model" name="${esc(p.name)}" pid="1" pindex="${i}"><mesh><vertices>`);
    for (let v = 0; v < vertices.length; v += 3) out.push(`<vertex x="${fmt(vertices[v])}" y="${fmt(vertices[v + 1])}" z="${fmt(vertices[v + 2])}"/>`);
    out.push(`</vertices><triangles>`);
    for (let t = 0; t < triangles.length; t += 3) out.push(`<triangle v1="${triangles[t]}" v2="${triangles[t + 1]}" v3="${triangles[t + 2]}"/>`);
    out.push(`</triangles></mesh></object>`);
  });
  const whole = parts.length + 2;
  out.push(`<object id="${whole}" type="model" name="${esc(name)}"><components>`);
  parts.forEach((_, i) => out.push(`<component objectid="${i + 2}"/>`));
  out.push(`</components></object>`);
  out.push(`</resources>`);
  out.push(`<build><item objectid="${whole}"/></build>`);
  out.push(`</model>`);
  return out.join("\n");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

/** A .3mf file: the parts as one multi-part object. */
export function meshesTo3mf(parts: ThreeMfPart[], name = "model"): Uint8Array {
  return zipStored([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "3D/3dmodel.model", data: modelXml(parts, name) },
  ]);
}

// ---- a minimal zip writer (stored entries) ---------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStored(files: { name: string; data: string | Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: typeof f.data === "string" ? enc.encode(f.data) : f.data }));
  const size = entries.reduce((s, e) => s + 30 + e.name.length + e.data.length + 46 + e.name.length, 0) + 22;
  const buf = new Uint8Array(size), dv = new DataView(buf.buffer);
  let o = 0;
  const offsets: number[] = [], crcs: number[] = [];
  for (const e of entries) {
    offsets.push(o);
    const crc = crc32(e.data);
    crcs.push(crc);
    dv.setUint32(o, 0x04034b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 0, true); dv.setUint16(o + 8, 0, true);
    dv.setUint16(o + 10, 0, true); dv.setUint16(o + 12, 0x21, true); // time 00:00, date 1980-01-01
    dv.setUint32(o + 14, crc, true); dv.setUint32(o + 18, e.data.length, true); dv.setUint32(o + 22, e.data.length, true);
    dv.setUint16(o + 26, e.name.length, true); dv.setUint16(o + 28, 0, true);
    buf.set(e.name, o + 30); buf.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  }
  const dir = o;
  entries.forEach((e, i) => {
    dv.setUint32(o, 0x02014b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 20, true); dv.setUint16(o + 8, 0, true); dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, 0, true); dv.setUint16(o + 14, 0x21, true);
    dv.setUint32(o + 16, crcs[i], true); dv.setUint32(o + 20, e.data.length, true); dv.setUint32(o + 24, e.data.length, true);
    dv.setUint16(o + 28, e.name.length, true); dv.setUint16(o + 30, 0, true); dv.setUint16(o + 32, 0, true); dv.setUint16(o + 34, 0, true);
    dv.setUint16(o + 36, 0, true); dv.setUint32(o + 38, 0, true); dv.setUint32(o + 42, offsets[i], true);
    buf.set(e.name, o + 46);
    o += 46 + e.name.length;
  });
  dv.setUint32(o, 0x06054b50, true); dv.setUint16(o + 4, 0, true); dv.setUint16(o + 6, 0, true);
  dv.setUint16(o + 8, entries.length, true); dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - dir, true); dv.setUint32(o + 16, dir, true); dv.setUint16(o + 20, 0, true);
  return buf;
}
