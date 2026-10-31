// Verbs on a clicked face: Push/Pull its feature's driving number, look at it,
// measure it. Anchored at the click, closed by × or Escape.

import { useEffect, useRef, useState, KeyboardEvent } from "react";
import { useStore } from "../../../model/store";
import { useViewportRect, toLocal } from "../../kit/useProjected";
import { placeCard, CARD_W_WIDE, CARD_FALLBACK_H } from "../../kit/anchor";
import { Button, Card, Readout } from "../../kit/primitives";
import { LiveNumber } from "../../kit/LiveNumber";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { useEditQueue } from "../../kit/useEditQueue";
import { useCardSize } from "../../kit/useCardSize";
import { measurements, paramsWith, pushEdit, pushParamOf, rowForFace } from "./workbench";
import { lookAtFace } from "../contextActions";

export function FaceVerbs() {
  const rows = useFeatureRows();
  const mode = useStore((s) => s.mode);
  const sel = useStore((s) => s.faceSelection);
  const solids = useStore((s) => s.solids);
  const selectFace = useStore((s) => s.selectFace);
  const rect = useViewportRect();
  const [measuring, setMeasuring] = useState(false);
  const edit = useEditQueue();
  const cardRef = useRef<HTMLDivElement>(null);
  const size = useCardSize(cardRef, { w: CARD_W_WIDE, h: CARD_FALLBACK_H });
  useEffect(() => { setMeasuring(false); }, [sel?.bodyId, sel?.faceName]);

  if (!sel || mode !== "model") return null;
  const row = rowForFace(rows, sel.faceName, sel.bodyId);
  const push = pushParamOf(row);
  const metrics = measuring ? measurements(solids[sel.bodyId], sel.faceName) : [];
  const bounds = { w: rect.w, h: rect.h };
  const at = placeCard({ anchor: toLocal(sel.screen, rect), size, bounds, prefer: "below" });
  const close = () => selectFace(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const sendPush = (v: number) => { if (row && push) edit.live(row.opId, paramsWith(row, push.key, v)); };
  const commitPush = (v: number) => { if (row && push) edit.commit(row.opId, paramsWith(row, push.key, v)); };
  const step = (dir: -1 | 1) => { const e = pushEdit(row, dir); if (e) edit.live(e.opId, e.params); };

  return (
    <div style={{ display: "contents" }} onKeyDown={onKey}>
      <Card ref={cardRef} role="toolbar" ariaLabel={row ? `Face of ${row.name}` : "Face"} at={at} width={CARD_W_WIDE} className="wb-verbs" onClose={close} title={row ? row.name : sel.faceName ?? "Face"}>
        <div className="wb-verb-row">
          {row && push && (
            <span className="wb-push" role="group" aria-label="Push/Pull">
              <Button size="sm" icon ariaLabel={`Pull ${push.label} in`} onClick={() => step(-1)}>−</Button>
              <LiveNumber value={push.value} spec={push.spec} unit={push.unit} name={`${push.label} (Push/Pull)`} onChange={sendPush} onCommit={commitPush} />
              <Button size="sm" icon ariaLabel={`Push ${push.label} out`} onClick={() => step(1)}>+</Button>
            </span>
          )}
          <Button size="sm" title="Orient the view to this face" onClick={() => lookAtFace(sel)}>Look at</Button>
          <Button size="sm" on={measuring} onClick={() => setMeasuring((m) => !m)}>Measure</Button>
        </div>
        {measuring && (
          <div className="wb-measure">
            {metrics.length ? metrics.map((m) => <Readout key={m.label} label={m.label} value={m.value} title={m.title} />) : <span className="k-dim">Nothing measured yet — the body has no metrics</span>}
          </div>
        )}
      </Card>
    </div>
  );
}
