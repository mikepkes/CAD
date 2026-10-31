// The card beside the open pin: the feature's live numbers and its history verbs.
// Edits go through store.editOperation, at most one in flight while scrubbing.

import { useMemo, useRef } from "react";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { useProjected, useViewportRect } from "../../kit/useProjected";
import { placeCard, pinOffset, CARD_W } from "../../kit/anchor";
import { Button, Card } from "../../kit/primitives";
import { LiveNumber } from "../../kit/LiveNumber";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { useEditQueue } from "../../kit/useEditQueue";
import { useCardSize } from "../../kit/useCardSize";
import { cardHeight, cardParams, paramsWith, pinAnchors, quadrantDir } from "./workbench";
import { deleteFeature } from "../contextActions";

export function FeatureCard() {
  const rows = useFeatureRows();
  const mode = useStore((s) => s.mode);
  const moveRollback = useStore((s) => s.moveRollback);
  const suppressOperation = useStore((s) => s.suppressOperation);
  const openFeature = useUi((s) => s.openFeature);
  const setOpenFeature = useUi((s) => s.setOpenFeature);
  const setHotParam = useUi((s) => s.setHotParam);
  const rect = useViewportRect();
  const edit = useEditQueue();

  const i = rows.findIndex((r) => r.featureId === openFeature);
  const row = i >= 0 ? rows[i] : undefined;
  const anchor = i >= 0 ? pinAnchors(rows)[i] : null;
  const [proj] = useProjected(anchor ? [anchor] : []);
  const params = useMemo(() => (row ? cardParams(row) : []), [row]);
  const cardRef = useRef<HTMLDivElement>(null);
  const size = useCardSize(cardRef, { w: CARD_W, h: cardHeight(params.length) });
  if (!row || mode !== "model") return null;

  const bounds = { w: rect.w, h: rect.h };
  const pinPos = proj?.visible ? pinOffset({ x: proj.x, y: proj.y }, quadrantDir({ x: proj.x, y: proj.y }, bounds)) : { x: 24, y: 24 };
  const at = placeCard({ anchor: pinPos, size, bounds });

  return (
    <Card
      ref={cardRef}
      at={at}
      width={CARD_W}
      num={row.num}
      title={row.name}
      onClose={() => setOpenFeature(null)}
      className="wb-card"
      foot={
        <>
          <Button size="sm" title="Roll the history back to just before this feature" onClick={() => void moveRollback(row.index)}>Roll back to here</Button>
          <Button size="sm" on={row.suppressed} onClick={() => void suppressOperation(row.opId, !row.suppressed)}>{row.suppressed ? "Unsuppress" : "Suppress"}</Button>
          <Button
            size="sm"
            ghost
            title="Delete this feature"
            onClick={() => void deleteFeature(row)}
          >
            Delete
          </Button>
        </>
      }
    >
      {row.error && <div className="k-dim wb-error" role="alert">{row.error}</div>}
      {row.rolledBack && <div className="k-dim">Rolled back — not built</div>}
      {params.length === 0 && !row.error && <div className="k-dim">No editable numbers</div>}
      {params.map((p) => (
        <div key={p.key} className="wb-param">
          <span className="k-label">{p.label}</span>
          {p.numeric ? (
            <LiveNumber
              value={p.value}
              spec={p.spec}
              unit={p.unit}
              name={`${row.name} ${p.label.toLowerCase()}`}
              onChange={(v) => edit.live(row.opId, paramsWith(row, p.key, v))}
              onCommit={(v) => edit.commit(row.opId, paramsWith(row, p.key, v))}
              onHover={(hot) => setHotParam(hot ? { featureId: row.featureId, key: p.key } : null)}
            />
          ) : (
            <span className="k-mono k-dim" title="This expression could not be evaluated">{p.expr}</span>
          )}
        </div>
      ))}
    </Card>
  );
}
