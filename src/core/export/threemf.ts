// 3MF export — the format Bambu Studio / MakerWorld prefer. A 3MF is an OPC
// (zip) package; we write it with a tiny store-only zip writer so there's no
// dependency. Each body becomes its own <object> (so a print-in-place assembly
// opens as separate, named parts) and the world is Z-up millimetres, matching
// our model, so no transform is needed.

export interface TriMesh {
  name: string;
  positions: Float32Array; // flat x,y,z, millimetres
  indices: Uint32Array;    // triangle vertex indices
}

const num = (n: number) => String(Math.round(n * 1e4) / 1e4);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function modelXml(bodies: TriMesh[]): string {
  const objects: string[] = [];
  const items: string[] = [];
  bodies.forEach((b, i) => {
    const id = i + 1;
    const p = b.positions, idx = b.indices;
    const verts: string[] = [];
    for (let v = 0; v < p.length; v += 3) verts.push(`<vertex x="${num(p[v])}" y="${num(p[v + 1])}" z="${num(p[v + 2])}"/>`);
    const tris: string[] = [];
    for (let t = 0; t < idx.length; t += 3) tris.push(`<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}"/>`);
    objects.push(`<object id="${id}" type="model" name="${esc(b.name || `Part ${id}`)}"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${objects.join("")}</resources><build>${items.join("")}</build></model>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

export function meshesToThreeMF(bodies: TriMesh[]): Uint8Array {
  const enc = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "3D/3dmodel.model", data: enc.encode(modelXml(bodies)) },
  ]);
}

// ---- minimal store-only (uncompressed) zip writer -------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// Builds the byte stream chunk by chunk (never spreading a mesh-sized array
// into a call — that overflows the stack), then concatenates once at the end.
function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const put = (b: Uint8Array) => { chunks.push(b); size += b.length; };
  // Little-endian field writers into a fixed-size record.
  const rec = (...fields: [number, number][]) => { // [value, byteWidth]
    const total = fields.reduce((s, [, w]) => s + w, 0);
    const b = new Uint8Array(total);
    let o = 0;
    for (const [v, w] of fields) { for (let i = 0; i < w; i++) b[o + i] = (v >>> (8 * i)) & 255; o += w; }
    return b;
  };

  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data), len = f.data.length;
    const lh = rec([0x04034b50, 4], [20, 2], [0, 2], [0, 2], [0, 2], [0, 2], [crc, 4], [len, 4], [len, 4], [name.length, 2], [0, 2]);
    put(lh); put(name); put(f.data);
    central.push(rec([0x02014b50, 4], [20, 2], [20, 2], [0, 2], [0, 2], [0, 2], [0, 2], [crc, 4], [len, 4], [len, 4], [name.length, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]), name);
    offset += lh.length + name.length + len;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { put(c); centralSize += c.length; }
  put(rec([0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [centralSize, 4], [centralStart, 4], [0, 2]));

  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
