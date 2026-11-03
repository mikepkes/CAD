// The crease pattern of a paper model (origami, a pop-up card): the flat sheet with
// its valley (dashed) and mountain (dash-dot) folds, slits to cut and the step each
// fold is made in, to print at true size and fold. Shown over the model like the
// shop drawing; saves as SVG or as a vector PDF (1 mm on paper = 1 mm of the sheet).

import { useState } from "react";
import { Modal } from "./kit/Modal";
import { useStore } from "../model/store";
import { Button } from "./kit/primitives";
import { flatPatternPdf, flatPatternSvg, type FlatPattern } from "../core/sheet";
import { saveBlob } from "./pdf";

/** The built sheet bodies with something to fold or cut, in body order. */
export function creaseSheets(solids: ReturnType<typeof useStore.getState>["solids"]): { id: string; name: string; flat: FlatPattern }[] {
  return Object.values(solids)
    .filter((b) => b.sheet && (b.sheet.flat.folds.length > 0 || (b.sheet.flat.cuts?.length ?? 0) > 0))
    .map((b) => ({ id: b.featureId, name: b.name, flat: b.sheet!.flat }));
}

const fileName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "crease-pattern";

/** Save a crease pattern: SVG or a true-size vector PDF. */
export function saveCreasePattern(name: string, flat: FlatPattern, as: "svg" | "pdf") {
  const file = `${fileName(name)}-crease-pattern.${as}`;
  const blob = as === "svg"
    ? new Blob([flatPatternSvg(flat)], { type: "image/svg+xml" })
    : new Blob([flatPatternPdf(flat, `${name} crease pattern`) as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
  saveBlob(file, blob);
  useStore.setState({ toast: { kind: "info", text: `Saved ${file}` } });
}

/** The crease pattern as a dialog over the model (one sheet at a time when the model has several). */
export function CreasePatternView(p: { onClose: () => void }) {
  const solids = useStore((s) => s.solids);
  const sheets = creaseSheets(solids);
  const [pick, setPick] = useState<string | undefined>(undefined);
  const cur = sheets.find((s) => s.id === pick) ?? sheets[0];
  if (!cur) return null;
  const f = cur.flat;
  const w = f.max.x - f.min.x, h = f.max.y - f.min.y;
  const valleys = f.folds.filter((x) => x.angle > 0).length, mountains = f.folds.length - valleys;
  const steps = new Set(f.folds.map((x) => x.step).filter((x) => x !== undefined)).size;
  return (
    <Modal title={`${cur.name}: crease pattern`} onClose={p.onClose} className="drawing-view crease-view" actions={
      <span className="drawing-actions">
        {sheets.length > 1 && (
          <select className="crease-pick" aria-label="Sheet" value={cur.id} onChange={(e) => setPick(e.target.value)}>
            {sheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <Button size="sm" accent onClick={() => saveCreasePattern(cur.name, f, "pdf")}>Download PDF</Button>
        <Button size="sm" onClick={() => saveCreasePattern(cur.name, f, "svg")}>Download SVG</Button>
      </span>
    }>
      <div className="crease-body">
        {/* made by core/sheet.ts (flatPatternSvg) with every id escaped */}
        <div className="drawing-sheet crease-sheet" dangerouslySetInnerHTML={{ __html: flatPatternSvg(f) }} />
        <p className="crease-legend k-dim">
          <span className="crease-key valley" /> valley ({valleys}) <span className="crease-key mountain" /> mountain ({mountains})
          {f.cuts?.length ? <><span className="crease-key cut" /> cut ({f.cuts.length})</> : null}
          {steps ? <> · {steps} step{steps > 1 ? "s" : ""} (circled numbers)</> : null}
          {` · sheet ${w.toFixed(1)} × ${h.toFixed(1)} mm — print the PDF at 100% (actual size)`}
        </p>
      </div>
    </Modal>
  );
}
