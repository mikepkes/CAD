// A one-page PDF of a drawing sheet: the SVG rasterised at print resolution and
// wrapped in a minimal PDF (one page, one JPEG image filling it). No library:
// the PDF is a handful of objects and a cross-reference table.

/** A4 landscape in PDF points (1/72 in). The sheet's viewBox is A4 landscape too. */
export const A4_LANDSCAPE = { w: 841.89, h: 595.28 };

/** The PDF bytes of one page `pageW`×`pageH` pt showing a JPEG (`pxW`×`pxH`) edge to edge. */
export function pdfWithImage(jpeg: Uint8Array, pxW: number, pxH: number, pageW = A4_LANDSCAPE.w, pageH = A4_LANDSCAPE.h, title = "Drawing"): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const put = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; chunks.push(u); at += u.length; };
  const obj = (n: number, body: string | (() => void)) => { offsets[n] = at; put(`${n} 0 obj\n`); if (typeof body === "string") put(body); else body(); put("\nendobj\n"); };
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
  const W = pageW.toFixed(2), H = pageH.toFixed(2);
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  put("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, () => { put(`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); put(jpeg); put("\nendstream"); });
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  obj(6, `<< /Title (${esc(title)}) /Producer (VibeCAD) >>`);
  const xref = at;
  put(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  put(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(at);
  let k = 0;
  for (const c of chunks) { out.set(c, k); k += c.length; }
  return out;
}

/** Rasterise a drawing sheet (SVG) at `dpi` on A4 landscape and return it as a PDF blob. Browser only. */
export async function sheetPdf(svg: string, title: string, dpi = 300): Promise<Blob> {
  const pxW = Math.round((A4_LANDSCAPE.w / 72) * dpi), pxH = Math.round((A4_LANDSCAPE.h / 72) * dpi);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error("the sheet would not render")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = pxW; canvas.height = pxH;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, pxW, pxH);
    g.drawImage(img, 0, 0, pxW, pxH);
    const jpeg = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("could not encode the sheet"))), "image/jpeg", 0.92));
    const bytes = pdfWithImage(new Uint8Array(await jpeg.arrayBuffer()), pxW, pxH, A4_LANDSCAPE.w, A4_LANDSCAPE.h, title);
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Save a blob as a file. */
export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
