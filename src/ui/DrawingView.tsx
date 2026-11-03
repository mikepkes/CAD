// The shop drawing: the model's third-angle sheet (front, top and right views with
// overall dimensions, a title block and the cut list), made from the live geometry
// by the kernel (core/drawings.ts), with the cut list beside it and downloads.
//
// In the editor the sheet also takes annotations: a tool row places dimensions by
// picking the model's corners and edges on the views, cuts sections along a line
// and circles details; a picked annotation can be removed. Each is a drawing.*
// command (so it is undoable and the agent can do the same), and the sheet is
// redrawn from the kernel after it.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Modal } from "./kit/Modal";
import { useStore } from "../model/store";
import { Button } from "./kit/primitives";
import type { CutPart, PickTarget, SheetInfo, SheetViewInfo } from "../core/drawings";
import { dimensionSvg, dimensionText, measureDimension, sectionLineSvg, type Feature2, type P2 } from "../core/drawingAnnotations";
import { TOOLS, dimensionCommand, nearestTarget, refsWanted, sameRef, sectionLine, toPaper, toView, viewAt, type DrawingTool } from "./drawingPick";
import { saveBlob, sheetPdf } from "./pdf";

const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

/** The cut list as CSV (one row per distinct part). */
export function cutListCsv(parts: CutPart[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["part,qty,material,thickness_mm,width_mm,length_mm", ...parts.map((p) => [q(p.part), p.qty, q(p.material), p.thickness, p.width, p.length].join(","))].join("\n") + "\n";
}

/** Highlights on the sheet (paper units). */
const PICK = "#e8590c";
/** How near (paper units) the pointer has to be to pick a corner or an edge. */
const REACH = 9;

/** A feature drawn as a highlight in paper coordinates. */
function featureSvg(f: Feature2, P: (p: P2) => P2, strong: boolean): string {
  const w = strong ? 2.2 : 1.6, f1 = (v: number) => Math.round(v * 10) / 10;
  if (f.kind === "point") { const [x, y] = P(f.p); return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${strong ? 4.5 : 3.5}" fill="${PICK}" fill-opacity="0.35" stroke="${PICK}" stroke-width="1.4"/>`; }
  const pts = f.kind === "segment" ? [f.a, f.b] : f.pts;
  return `<polyline points="${pts.map((p) => P(p).map(f1).join(" ")).join(" ")}" fill="none" stroke="${PICK}" stroke-width="${w}" stroke-linecap="round" stroke-opacity="0.85"/>`;
}

/** The annotation tools and what they have picked so far. */
interface Picking { tool: DrawingTool; view?: string; targets: PickTarget[]; points: P2[] }

/** The sheet with its annotation layer: hover and picked highlights, and a preview of what the next click places. */
function Sheet(p: { svg: string; sheet?: SheetInfo; picking: Picking | null; selected: string | null; onPick: (view: SheetViewInfo, at: P2, target: PickTarget | undefined) => void; onSelect: (id: string | null) => void }) {
  const overlay = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ view: SheetViewInfo; at: P2; target?: PickTarget } | null>(null);
  const tool = p.picking?.tool;
  useEffect(() => { if (!p.picking) setHover(null); }, [p.picking]);

  /** The paper point under a pointer event (the overlay has the sheet's own coordinates). */
  const paperAt = (e: { clientX: number; clientY: number }): P2 | undefined => {
    const svg = overlay.current, m = svg?.getScreenCTM?.();
    if (!svg || !m) return undefined;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [q.x, q.y];
  };
  const locate = (e: ReactPointerEvent) => {
    const at = paperAt(e);
    if (!at || !p.sheet || !p.picking) return null;
    const inView = p.picking.view ? p.sheet.views.find((v) => v.id === p.picking!.view) : viewAt(p.sheet.views, at, 30);
    if (!inView) return null;
    const uv = toView(inView, at);
    const done = p.picking.targets.length >= refsWanted(p.picking.tool);
    const target = done ? undefined : nearestTarget(p.sheet.picks[inView.id] ?? [], uv, REACH / inView.scale, p.picking.tool);
    return { view: inView, at: uv, ...(target ? { target } : {}) };
  };

  // what the next click would place, drawn as the sheet will draw it
  let preview = "";
  if (p.picking && hover && p.sheet) {
    const { view, at } = hover;
    const P = (q: P2) => toPaper(view, q);
    for (const t of p.picking.targets) preview += featureSvg(t.f, P, true);
    if (hover.target && !p.picking.targets.some((t) => sameRef(t.ref, hover.target!.ref))) preview += featureSvg(hover.target.f, P, false);
    if (tool === "section" && p.picking.points.length === 1) {
      const line = sectionLine(view, p.picking.points[0], at);
      if (line) {
        const a = P([line.from.u, line.from.v]), b = P([line.to.u, line.to.v]), d: P2 = [b[0] - a[0], b[1] - a[1]];
        preview += sectionLineSvg(a, b, [d[1], -d[0]], "?");
      }
    } else if (tool === "detail" && p.picking.points.length === 1) {
      const c = P(p.picking.points[0]), r = Math.hypot(at[0] - p.picking.points[0][0], at[1] - p.picking.points[0][1]) * view.scale;
      preview += `<circle cx="${c[0]}" cy="${c[1]}" r="${r}" fill="none" stroke="${PICK}" stroke-width="1" stroke-dasharray="4 3"/>`;
    } else if (tool && p.picking.targets.length === refsWanted(tool) && refsWanted(tool) > 0) {
      const cmd = dimensionCommand(tool, view.id, p.picking.targets, at);
      if (cmd) {
        const m = measureDimension(cmd.kind, p.picking.targets.map((t) => t.f), cmd.offset, 100, [0, 0]);
        preview += m.ok ? dimensionSvg(m.geom, P, dimensionText(cmd.kind, m.geom.value), PICK) : "";
      }
    }
  }
  const sel = p.selected ? `.drawing-sheet [data-dim="${p.selected}"] *, .drawing-sheet [data-section="${p.selected}"] *, .drawing-sheet [data-detail="${p.selected}"] * { stroke: ${PICK}; }
    .drawing-sheet [data-dim="${p.selected}"] text, .drawing-sheet [data-dim="${p.selected}"] path, .drawing-sheet [data-section="${p.selected}"] text, .drawing-sheet [data-detail="${p.selected}"] text { fill: ${PICK}; }` : "";

  return (
    <div className={`drawing-sheet${tool ? " picking" : ""}`}
      onPointerMove={(e) => { if (p.picking) setHover(locate(e)); }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        if (!p.picking) {
          const hit = (e.target as Element).closest?.("[data-dim],[data-section],[data-detail]");
          p.onSelect(hit?.getAttribute("data-dim") ?? hit?.getAttribute("data-section") ?? hit?.getAttribute("data-detail") ?? null);
          return;
        }
        const h = locate(e as unknown as ReactPointerEvent);
        if (h) p.onPick(h.view, h.at, h.target);
      }}>
      {/* the sheet is generated by core/drawings.ts with every label escaped */}
      <div className="drawing-paper" dangerouslySetInnerHTML={{ __html: p.svg }} />
      <svg ref={overlay} className="drawing-overlay" viewBox="0 0 1120 790" aria-hidden="true">
        {sel && <style>{sel}</style>}
        <g dangerouslySetInnerHTML={{ __html: preview }} />
      </svg>
    </div>
  );
}

/** The sheet as a dialog over the model. `viewer`: in the customize viewer (no publishing switch there, and no
 *  annotating). */
export function DrawingView(p: { viewer?: boolean } = {}) {
  const drawing = useStore((s) => s.drawing);
  const close = useStore((s) => s.closeDrawing);
  const published = useStore((s) => !!s.session.doc.drawing);
  const drafting = useStore((s) => s.session.doc.drafting);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const ready = !!drawing && "svg" in drawing;
  const sheet = ready ? drawing.sheet : undefined;

  /** Run a drawing command; on success redraw the sheet. */
  const run = async (type: string, params: Record<string, unknown>) => {
    const r = await useStore.getState().dispatch(type, params);
    if (!r.ok) { useStore.setState({ toast: { kind: "error", text: r.error ?? `${type} failed` } }); return false; }
    void useStore.getState().openDrawing({ refresh: true });
    return true;
  };
  const remove = (id: string) => { setSelected(null); void run("drawing.remove", { id }); };

  // Escape steps back (a pick, then the tool, then the selection) before it closes the dialog; Delete removes
  useEffect(() => {
    if (p.viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      if (e.key === "Escape" && (picking || selected)) {
        e.preventDefault();
        if (picking && (picking.targets.length || picking.points.length)) setPicking({ ...picking, view: undefined, targets: [], points: [] });
        else if (picking) setPicking(null);
        else setSelected(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); remove(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!drawing) return null;
  const file = ready ? drawing.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "drawing" : "drawing";

  const onPick = (view: SheetViewInfo, at: P2, target: PickTarget | undefined) => {
    if (!picking) return;
    const { tool } = picking;
    if (tool === "section" || tool === "detail") {
      if (tool === "section" && view.kind !== "ortho") { useStore.setState({ toast: { kind: "info", text: "A section is cut on the front, top or right view." } }); return; }
      if (tool === "detail" && view.kind === "detail") return;
      if (!picking.points.length) { setPicking({ ...picking, view: view.id, points: [at] }); return; }
      const a = picking.points[0];
      setPicking({ tool, targets: [], points: [] });
      if (tool === "section") { const line = sectionLine(view, a, at); if (line) void run("drawing.addSection", { base: view.id, ...line }); }
      else { const radius = Math.hypot(at[0] - a[0], at[1] - a[1]); if (radius > 1e-3) void run("drawing.addDetail", { base: view.id, center: { u: a[0], v: a[1] }, radius: Math.round(radius * 100) / 100, scale: 2 }); }
      return;
    }
    if (picking.targets.length < refsWanted(tool)) {
      if (target && !picking.targets.some((t) => sameRef(t.ref, target.ref))) setPicking({ ...picking, view: view.id, targets: [...picking.targets, target] });
      return;
    }
    const cmd = dimensionCommand(tool, view.id, picking.targets, at);
    setPicking({ tool, targets: [], points: [] });
    if (cmd) void run("drawing.addDimension", cmd);
    else useStore.setState({ toast: { kind: "info", text: "Those can't take that dimension (an angle needs two edges that meet)." } });
  };

  const status = (id: string) => sheet?.dimensions.find((d) => d.id === id);
  const toolHint = picking ? TOOLS.find((t) => t.id === picking.tool)!.hint : "Pick a dimension, section or detail on the sheet to select it; Delete removes it.";
  const annotations = [...(drafting?.dimensions ?? []).map((d) => ({ id: d.id, what: `${d.kind} · ${d.view}`, value: status(d.id)?.broken ? "broken" : status(d.id)?.text ?? "…", broken: status(d.id)?.broken })),
    ...(drafting?.sections ?? []).map((s) => ({ id: s.id, what: `section ${s.label}–${s.label} · ${s.base}`, value: "", broken: undefined as string | undefined })),
    ...(drafting?.details ?? []).map((d) => ({ id: d.id, what: `detail ${d.label} · ${d.base}`, value: `${d.scale}×`, broken: undefined as string | undefined }))];

  return (
    <Modal title={ready ? drawing.title : "Shop drawing"} onClose={close} className="drawing-view" closeOnEscape={!picking && !selected} actions={
          <span className="drawing-actions">
            {!p.viewer && (
              <label className="drawing-publish" title="People who open the shared model (its customize view) get a button for this drawing, with a PDF download. Saved with the model.">
                <input type="checkbox" checked={published} onChange={(e) => void useStore.getState().dispatch("drawing.publish", e.target.checked ? (ready ? { title: drawing.title } : {}) : { off: true })} /> Offer this drawing to people viewing the shared model
              </label>
            )}
            {ready && (
              <Button size="sm" accent disabled={pdfBusy} onClick={() => {
                setPdfBusy(true);
                sheetPdf(drawing.svg, drawing.title)
                  .then((b) => { saveBlob(`${file}.pdf`, b); useStore.setState({ toast: { kind: "info", text: `Saved ${file}.pdf` } }); })
                  .catch((e) => useStore.setState({ toast: { kind: "error", text: `PDF failed: ${(e as Error).message}` } }))
                  .finally(() => setPdfBusy(false));
              }}>{pdfBusy ? "Making PDF…" : "Download PDF"}</Button>
            )}
            {ready && <Button size="sm" onClick={() => download(`${file}.svg`, drawing.svg, "image/svg+xml")}>Download SVG</Button>}
            {ready && <Button size="sm" onClick={() => download(`${file}-cut-list.csv`, cutListCsv(drawing.parts), "text/csv")}>Cut list (CSV)</Button>}
          </span>
        }>
        {!ready ? (
          <div className="drawing-loading k-dim">Drawing the views…</div>
        ) : (
          <div className="drawing-body">
            <div className="drawing-main">
              {!p.viewer && (
                <div className="drawing-tools" role="toolbar" aria-label="Annotate the drawing">
                  {TOOLS.map((t) => (
                    <Button key={t.id} size="sm" on={picking?.tool === t.id} title={t.hint} disabled={!sheet}
                      onClick={() => { setSelected(null); setPicking(picking?.tool === t.id ? null : { tool: t.id, targets: [], points: [] }); }}>{t.label}</Button>
                  ))}
                  {selected && <Button size="sm" onClick={() => remove(selected)} title="Remove the selected annotation (Delete)">Remove {selected}</Button>}
                  {selected && drafting?.sections.some((s) => s.id === selected) && (
                    <Button size="sm" onClick={() => void run("drawing.edit", { id: selected, flip: !drafting.sections.find((s) => s.id === selected)!.flip })}>Flip</Button>
                  )}
                  <span className="drawing-hint k-dim">{toolHint}</span>
                </div>
              )}
              <Sheet svg={drawing.svg} sheet={sheet} picking={p.viewer ? null : picking} selected={selected} onPick={onPick} onSelect={p.viewer ? () => {} : setSelected} />
            </div>
            <div className="drawing-parts">
              <h3 className="k-label">Cut list</h3>
              <table>
                <thead><tr><th>Part</th><th>Qty</th><th>T × W × L (mm)</th></tr></thead>
                <tbody>
                  {drawing.parts.map((p, i) => (
                    // the same part and material can come twice in different sizes (two Pins): the row's place keeps keys unique
                    <tr key={`${i}:${p.part}:${p.material}`}><td>{p.part}<span className="k-dim"> · {p.material}</span></td><td>{p.qty}</td><td className="k-mono">{p.thickness} × {p.width} × {p.length}</td></tr>
                  ))}
                </tbody>
              </table>
              {!p.viewer && annotations.length > 0 && (
                <>
                  <h3 className="k-label">Annotations</h3>
                  <ul className="drawing-annotations">
                    {annotations.map((a) => (
                      <li key={a.id} className={`${a.id === selected ? "on" : ""}${a.broken ? " broken" : ""}`} title={a.broken}>
                        <button type="button" className="drawing-annotation" onClick={() => setSelected(a.id === selected ? null : a.id)}>
                          <span className="k-mono">{a.value || a.id}</span> <span className="k-dim">{a.what}</span>
                        </button>
                        <button type="button" className="drawing-annotation-remove" aria-label={`Remove ${a.id}`} onClick={() => remove(a.id)}>×</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
    </Modal>
  );
}
