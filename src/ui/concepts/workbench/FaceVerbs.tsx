// Verbs on a clicked face: Push/Pull its number, name that number, round or
// chamfer its edges, look at it, measure it. Anchored at the click, closed by ×
// or Escape. Push/Pull is direct modelling: on a box only the grabbed face moves,
// and a number that is already a named parameter moves the parameter.

import { useEffect, useMemo, useRef, useState, KeyboardEvent } from "react";
import { useStore } from "../../../model/store";
import { useViewportRect, toLocal } from "../../kit/useProjected";
import { placeCard, CARD_W_WIDE, CARD_FALLBACK_H } from "../../kit/anchor";
import { Button, Card, Readout } from "../../kit/primitives";
import { LiveNumber } from "../../kit/LiveNumber";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { useCardSize } from "../../kit/useCardSize";
import { createEditQueue } from "../../kit/editQueue";
import { measurements, namedParam, pushEdit, pushTargetOf, pushTo, rowForFace } from "./workbench";
import { faceEdgeSelector } from "../contextActions.logic";
import { applyPush, edgeFace, lookAtFace, nameThisNumber, pushKey } from "../contextActions";

export function FaceVerbs() {
  const rows = useFeatureRows();
  const mode = useStore((s) => s.mode);
  const sel = useStore((s) => s.faceSelection);
  const solids = useStore((s) => s.solids);
  const selectFace = useStore((s) => s.selectFace);
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
  const target = pushTargetOf(row, sel.normal);
  const push = target?.param ?? null;
  const named = push ? namedParam(push.expr, names) : null;
  const canEdge = !!faceEdgeSelector(sel.point, sel.normal);
  const metrics = measuring ? measurements(solids[sel.bodyId], sel.faceName) : [];
  const bounds = { w: rect.w, h: rect.h };
  const at = placeCard({ anchor: toLocal(sel.screen, rect), size, bounds, prefer: "below" });
  const close = () => selectFace(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const sendPush = (v: number) => { if (row && target) queue.live(pushTo(row, target, v, names)); };
  const commitPush = (v: number) => { if (row && target) queue.commit(pushTo(row, target, v, names)); };
  const step = (dir: -1 | 1) => { const e = pushEdit(row, dir, sel.normal, names); if (e) queue.live(e); };

  return (
    <div style={{ display: "contents" }} onKeyDown={onKey}>
      <Card ref={cardRef} role="toolbar" ariaLabel={row ? `Face of ${row.name}` : "Face"} at={at} width={CARD_W_WIDE} className="wb-verbs" onClose={close} title={row ? row.name : sel.faceName ?? "Face"}>
        <div className="wb-verb-row">
          {row && push && (
            <span className="wb-push" role="group" aria-label="Push/Pull">
              <Button size="sm" icon ariaLabel={`Pull ${push.label} in`} onClick={() => step(-1)}>−</Button>
              <LiveNumber value={push.value} spec={push.spec} unit={push.unit} name={`${push.label} (Push/Pull)`} onChange={sendPush} onCommit={commitPush} />
              <Button size="sm" icon ariaLabel={`Push ${push.label} out`} onClick={() => step(1)}>+</Button>
              {named
                ? <span className="k-mono k-dim wb-named" title={`This number is the parameter ${named}`}>= {named}</span>
                : <Button size="sm" ghost icon ariaLabel={`Name this number (${push.label})`} title="Name this number: make it a parameter" onClick={() => void nameThisNumber(row, push)}>ƒ</Button>}
            </span>
          )}
          <Button size="sm" title="Orient the view to this face" onClick={() => lookAtFace(sel)}>Look at</Button>
          <Button size="sm" on={measuring} onClick={() => setMeasuring((m) => !m)}>Measure</Button>
        </div>
        {canEdge && (
          <div className="wb-verb-row">
            <Button size="sm" title="Round every edge around this face (a fillet you can resize or name)" onClick={() => void edgeFace("fillet")}>Round edges</Button>
            <Button size="sm" title="Bevel every edge around this face" onClick={() => void edgeFace("chamfer")}>Chamfer edges</Button>
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
