// Painting a note's drawing onto a 2D canvas: the Notes panel's drawing pad
// and notes_render (the agent's look at a person's sketch) draw the same
// strokes the same way, so what the agent sees is what was drawn.

import type { NoteDrawing, NoteStroke } from "../core/document";
import { NOTE_SPACE } from "../core/notes";

/** Draw strokes on a `size`×`size` canvas context (a stroke's width scales with the canvas). */
export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: NoteStroke[], size: number): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (!s.points.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.width / NOTE_SPACE) * size;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * size, s.points[0].y * size);
    // a single point is a dot: a zero-length segment the round cap draws
    for (const p of s.points.length > 1 ? s.points.slice(1) : s.points) ctx.lineTo(p.x * size, p.y * size);
    ctx.stroke();
  }
}

/** Load an image (a data URL) for drawing. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the note's background image could not be read"));
    img.src = src;
  });
}

/** Draw an image to fill a square (centre-cropped, like the SVG's xMidYMid slice), or paper white. */
export function paintBackground(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, size: number): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  if (!img || !img.width || !img.height) return;
  const k = Math.max(size / img.width, size / img.height);
  const w = img.width * k, h = img.height * k;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

/** The drawing over its background, as PNG base64 (no data: prefix). Browser only. */
export async function rasterizeNote(drawing: NoteDrawing | undefined, size = 768): Promise<string> {
  const px = Math.max(64, Math.min(Math.round(size), 1600));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas to draw the note on");
  paintBackground(ctx, drawing?.background ? await loadImage(drawing.background) : null, px);
  paintStrokes(ctx, drawing?.strokes ?? [], px);
  return canvas.toDataURL("image/png").split(",")[1];
}

/** A captured view as small as it reads well: the PNG, or a JPEG of it when that is smaller (a shaded
 *  render usually is, by several times). Falls back to the PNG where there is no canvas. */
export async function compactImage(pngDataUrl: string, quality = 0.85): Promise<string> {
  try {
    const img = await loadImage(pngDataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return pngDataUrl;
    ctx.fillStyle = "#ffffff"; // JPEG has no alpha
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const jpeg = canvas.toDataURL("image/jpeg", quality);
    return jpeg.startsWith("data:image/jpeg") && jpeg.length < pngDataUrl.length ? jpeg : pngDataUrl;
  } catch {
    return pngDataUrl;
  }
}
