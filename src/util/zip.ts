// A minimal ZIP reader (stored and deflated entries, no ZIP64) — enough for
// the archives CAD tools save (FreeCAD's .FCStd, 3MF). Inflation uses the
// platform's DecompressionStream ("deflate-raw"), present in browsers, Web
// Workers and Node 18+.

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every file in a ZIP archive, by path. Throws if `bytes` isn't a readable ZIP. */
export async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  // End-of-central-directory record: scan back over a possible trailing comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out: Record<string, Uint8Array> = {};
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const method = u16(bytes, p + 10);
    const size = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // a directory
    if (u32(bytes, local) !== 0x04034b50) throw new Error(`corrupt ZIP entry "${name}"`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out[name] = raw.slice();
    else if (method === 8) out[name] = await inflateRaw(raw);
    else throw new Error(`ZIP entry "${name}" uses unsupported compression (method ${method})`);
  }
  return out;
}
