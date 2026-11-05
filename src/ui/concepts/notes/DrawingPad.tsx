// A square drawing pad: pen (four colours, three widths), an eraser that takes
// whole strokes, undo, clear, and "Capture view" to put what the viewport shows
// behind the strokes (the render_view path, through the live camera). It edits
// a draft the note editor holds; nothing is sent until the note is saved.

import { useEffect, useRef, useState } from "react";
import type { NoteStroke, NoteView } from "../../../core/document";
import { eraseStrokes } from "../../../core/notes";
import { compactImage, paintStrokes } from "../../../viewport/notePaint";
import { Button } from "../../kit/primitives";
import { useScene } from "../../kit/useProjected";
import { ERASER_R, PEN_COLORS, PEN_WIDTHS, finishStroke, padPoint } from "./notes";

export interface DrawingPadProps {
  strokes: NoteStroke[];
  background?: string;
  onStrokes: (s: NoteStroke[]) => void;
  /** A new background (undefined: blank), with the camera it was captured from. */
  onBackground: (src: string | undefined, view?: NoteView) => void;
}

type Tool = "pen" | "eraser";

export function DrawingPad(p: DrawingPadProps) {
  const scene = useScene();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(PEN_COLORS[0].key);
  const [width, setWidth] = useState<number>(PEN_WIDTHS[1].key);
  const [history, setHistory] = useState<NoteStroke[][]>([]);
  const [capturing, setCapturing] = useState(false);
  // the gesture in progress: the pen's points, or the strokes the eraser has left so far
  const live = useRef<{ points: { x: number; y: number }[]; left: NoteStroke[] } | null>(null);
  const [, redraw] = useState(0);

  const commit = (next: NoteStroke[]) => { setHistory((h) => [...h.slice(-49), p.strokes]); p.onStrokes(next); };

  // paint at the pad's size on screen (crisp on a high-density display); jsdom has no 2D context, which is fine
  const paint = () => {
    const el = canvas.current;
    const ctx = el?.getContext?.("2d");
    if (!el || !ctx) return;
    const size = Math.round(el.clientWidth * (window.devicePixelRatio || 1));
    if (!size) return;
    if (el.width !== size) { el.width = size; el.height = size; }
    ctx.clearRect(0, 0, size, size);
    const g = live.current;
    const shown = g && tool === "eraser" ? g.left : p.strokes;
    paintStrokes(ctx, shown, size);
    if (g && tool === "pen" && g.points.length) paintStrokes(ctx, [{ color, width, points: g.points }], size);
  };
  useEffect(paint);
  useEffect(() => {
    const el = canvas.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => redraw((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const at = (e: React.PointerEvent) => padPoint(e.clientX, e.clientY, canvas.current!.getBoundingClientRect());
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const q = at(e);
    if (!q) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    live.current = { points: [q], left: tool === "eraser" ? eraseStrokes(p.strokes, q, ERASER_R) : p.strokes };
    paint();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = live.current, q = g && at(e);
    if (!g || !q) return;
    if (tool === "eraser") g.left = eraseStrokes(g.left, q, ERASER_R);
    else {
      const last = g.points[g.points.length - 1];
      if (Math.hypot(q.x - last.x, q.y - last.y) < 0.002) return;
      g.points.push(q);
    }
    paint();
  };
  const up = () => {
    const g = live.current;
    live.current = null;
    if (!g) return;
    if (tool === "eraser") { if (g.left.length !== p.strokes.length) commit(g.left); else paint(); return; }
    const s = finishStroke(g.points, color, width);
    if (s) commit([...p.strokes, s]);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    p.onStrokes(prev);
  };

  const capture = async () => {
    if (!scene) return;
    setCapturing(true);
    try {
      const shot = scene.renderView({ fromCamera: true, width: 768, height: 768 });
      p.onBackground(await compactImage(`data:image/png;base64,${shot.base64}`), scene.cameraView());
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="notes-pad">
      <div className="notes-pad-tools" role="toolbar" aria-label="Drawing tools">
        <div className="k-pills" role="group" aria-label="Pen colour">
          {PEN_COLORS.map((c) => (
            <button key={c.key} type="button" className={`notes-swatch${tool === "pen" && color === c.key ? " on" : ""}`} style={{ background: c.key }}
              aria-label={c.label} aria-pressed={tool === "pen" && color === c.key} title={`${c.label} pen`} onClick={() => { setColor(c.key); setTool("pen"); }} />
          ))}
        </div>
        <div className="k-pills" role="group" aria-label="Pen width">
          {PEN_WIDTHS.map((w) => (
            <Button key={w.key} size="sm" on={width === w.key} title={`${w.label} line`} ariaLabel={w.label} onClick={() => { setWidth(w.key); setTool("pen"); }}>
              <span className="notes-width" style={{ height: Math.max(1, w.key / 2) }} />
            </Button>
          ))}
        </div>
        <Button size="sm" on={tool === "eraser"} title="Eraser: drag over a stroke to remove it" onClick={() => setTool(tool === "eraser" ? "pen" : "eraser")}>Erase</Button>
        <Button size="sm" ghost disabled={!history.length} title="Undo the last stroke or erase" onClick={undo}>Undo</Button>
        <Button size="sm" ghost disabled={!p.strokes.length} title="Remove every stroke (Undo brings them back)" onClick={() => commit([])}>Clear</Button>
      </div>
      <div className={`notes-canvas${p.background ? " on-image" : ""}${tool === "eraser" ? " erasing" : ""}`}>
        {p.background && <img src={p.background} alt="Captured view under the drawing" draggable={false} />}
        <canvas ref={canvas} aria-label="Drawing pad" data-testid="notes-pad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
      <div className="notes-pad-tools">
        <Button size="sm" disabled={!scene || capturing} title={scene ? "Put what the view shows now behind the drawing (and remember the camera)" : "The 3D view isn't ready"} onClick={() => void capture()}>
          {p.background ? "Capture again" : "Capture view"}
        </Button>
        {p.background && <Button size="sm" ghost title="Draw on a blank page instead" onClick={() => p.onBackground(undefined)}>Remove image</Button>}
        <span className="k-dim notes-count">{p.strokes.length} stroke{p.strokes.length === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}
