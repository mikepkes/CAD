// Verbs on a clicked face: sketch on it or extrude from it, Push/Pull its number,
// name that number, round or chamfer its edges, look at it, measure it. Anchored
// beside the click (so the face stays visible), closed by × or Escape. Push/Pull
// is direct modelling: on a box only the grabbed face moves, on an extrude only
// its caps push (the one clicked moves), a number that is already a named
// parameter moves the parameter, and a formula is never overwritten: it is
// edited as text ("edit formula…").

import { useEffect, useMemo, useRef, useState, KeyboardEvent } from "react";
import { useStore } from "../../../model/store";
import { useViewportRect, toLocal } from "../../kit/useProjected";
import { placeCard, CARD_W_WIDE, CARD_FALLBACK_H } from "../../kit/anchor";
import { Button, Card, Readout } from "../../kit/primitives";
import { LiveNumber } from "../../kit/LiveNumber";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { useCardSize } from "../../kit/useCardSize";
import { createEditQueue } from "../../kit/editQueue";
import { formatValue } from "../../kit/numberMath";
import { extrudeCap, isFormula, measurements, namedParam, pushEdit, pushTargetOf, pushTo, rowForFace } from "./workbench";
import { applyPush, edgeFace, editFormula, faceHasEdges, lookAtFace, nameThisNumber, pushExpression, pushKey } from "../contextActions";

export function FaceVerbs() {
  const rows = useFeatureRows();
  const mode = useStore((s) => s.mode);
  const sel = useStore((s) => s.faceSelection);
  const solids = useStore((s) => s.solids);
  const selectFace = useStore((s) => s.selectFace);
  const kernelLoading = useStore((s) => s.kernelLoading);
  const names = useStore((s) => s.session.doc.parameters).map((p) => p.name);
  useStore((s) => s.rev);
  const rect = useViewportRect();
  const [measuring, setMeasuring] = useState(false);
  const queue = useMemo(() => createEditQueue(applyPush, pushKey), []);
  const cardRef = useRef<HTMLDivElement>(null);
  const size = useCardSize(cardRef, { w: CARD_W_WIDE, h: CARD_FALLBACK_H });
  useEffect(() => { setMeasuring(false); }, [sel?.bodyId, sel?.faceName]);

  if (!sel || mode !== "model") return null;
  const row = rowForFace(rows, sel.faceName, sel.bodyId);
  const target = pushTargetOf(row, sel.normal, sel.faceName);
  const push = target?.param ?? null;
  const named = push ? namedParam(push.expr, names) : null;
  const formula = !!push && isFormula(push.expr, names);
  const canEdge = faceHasEdges(sel);
  const metrics = measuring ? measurements(solids[sel.bodyId], sel.faceName) : [];
  const bounds = { w: rect.w, h: rect.h };
  // beside the click, not over it: the picked face stays in view
  const at = placeCard({ anchor: toLocal(sel.screen, rect), size, bounds, prefer: "right" });
  const close = () => selectFace(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const sendPush = (v: number) => { if (row && target) queue.live(pushTo(row, target, v, names)); };
  const commitPush = (v: number) => { if (row && target) queue.commit(pushTo(row, target, v, names)); };
  const step = (dir: -1 | 1) => { const e = pushEdit(row, dir, sel.normal, names, sel.faceName); if (e) queue.live(e); };
  const cap = row && row.spec.kind === "extrude" ? extrudeCap(sel.faceName, row.featureId) : null;
  const where = cap === "start" ? "start face" : cap === "end" ? "end face" : null;
  const title = row ? `${row.name}${where ? ` · ${where}` : ""}` : sel.faceName ?? "Face";
  const S = useStore.getState;

  return (
    <div style={{ display: "contents" }} onKeyDown={onKey}>
      <Card ref={cardRef} role="toolbar" ariaLabel={row ? `Face of ${row.name}` : "Face"} at={at} width={CARD_W_WIDE} className="wb-verbs" onClose={close} title={title}>
        <div className="wb-verb-row">
          <Button size="sm" title="Sketch on this face (S)" onClick={() => void S().startSketchOnFace(sel.point, sel.normal)}>Sketch</Button>
          <Button size="sm" disabled={kernelLoading} title="Extrude this face: a boss or a cut from its outline (E)" onClick={() => void S().startFaceExtrude(sel.point, sel.normal)}>Extrude</Button>
          <Button size="sm" title="Orient the view to this face (F)" onClick={() => lookAtFace(sel)}>Look at</Button>
          <Button size="sm" on={measuring} onClick={() => setMeasuring((m) => !m)}>Measure</Button>
        </div>
        {row && push && (
          <div className="wb-verb-row">
            <span className="wb-push" role="group" aria-label="Push/Pull">
              {formula ? (
                <>
                  <span className="k-mono wb-formula" title={`${push.label} is the formula ${push.expr}: Push/Pull won't replace it with a number`}>
                    {push.expr} = {formatValue(push.value, push.spec, push.unit)}
                  </span>
                  <Button size="sm" ghost title="Edit the formula as text" onClick={() => void editFormula(row, push)}>edit formula…</Button>
                </>
              ) : (
                <>
                  <Button size="sm" icon ariaLabel={`Pull ${push.label} in`} onClick={() => step(-1)}>−</Button>
                  <LiveNumber value={push.value} spec={push.spec} unit={push.unit} name={`${push.label} (Push/Pull)`} onChange={sendPush} onCommit={commitPush} onExpression={(text) => { if (target) void pushExpression(row, target, text); }} />
                  <Button size="sm" icon ariaLabel={`Push ${push.label} out`} onClick={() => step(1)}>+</Button>
                  {named
                    ? <span className="k-mono k-dim wb-named" title={`This number is the parameter ${named}`}>= {named}</span>
                    : <Button size="sm" ghost icon ariaLabel={`Name this number (${push.label})`} title="Name this number: make it a parameter" onClick={() => void nameThisNumber(row, push)}>ƒ</Button>}
                </>
              )}
            </span>
          </div>
        )}
        {canEdge && (
          <div className="wb-verb-row">
            <Button size="sm" title="Round every edge around this face (a fillet you can resize or name)" onClick={() => void edgeFace("fillet")}>Round edges</Button>
            <Button size="sm" title="Bevel every edge around this face" onClick={() => void edgeFace("chamfer")}>Chamfer edges</Button>
            <Button size="sm" title="Round the corner edges running back from this face, e.g. a plate's four corners" onClick={() => void edgeFace("fillet", "corners")}>Round corners</Button>
          </div>
        )}
        {measuring && (
          <div className="wb-measure">
            {metrics.length ? metrics.map((m) => <Readout key={m.label} label={m.label} value={m.value} title={m.title} />) : <span className="k-dim">Nothing measured yet — the body has no metrics</span>}
          </div>
        )}
      </Card>
    </div>
  );
}
