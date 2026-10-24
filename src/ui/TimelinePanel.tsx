import { useState } from "react";
import { useStore } from "../model/store";
import { OperationRecord } from "../core/command/types";

// Which sketch an operation belongs to (for context grouping). Features and
// parameters stay top-level; a sketch.create heads its own group, and the
// geometry/constraint/dimension ops that target a sketch nest under it.
function ownerSketch(op: OperationRecord): string | null {
  if (op.type.startsWith("feature.") || op.type.startsWith("parameter.")) return null;
  if (op.type === "sketch.create") return op.createdIds[0] ?? null;
  const s = op.params?.sketch;
  return typeof s === "string" ? s : null;
}

export function TimelinePanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const activeSketchId = useStore((s) => s.activeSketchId);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const suppressOperation = useStore((s) => s.suppressOperation);
  const deleteOperation = useStore((s) => s.deleteOperation);
  const moveRollback = useStore((s) => s.moveRollback);

  const ops = session.timeline;
  const rollback = session.rollbackIndex;

  // Explicit open/closed overrides; by default the active sketch is open, others closed.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (sid: string) => open[sid] ?? sid === activeSketchId;
  const toggle = (sid: string) => setOpen((o) => ({ ...o, [sid]: !isOpen(sid) }));

  // Group a sketch's member ops (kept in timeline order), and number sketches.
  const members = new Map<string, { op: OperationRecord; i: number }[]>();
  const sketchNum = new Map<string, number>();
  ops.forEach((op, i) => {
    const sid = ownerSketch(op);
    if (!sid) return;
    if (!members.has(sid)) { members.set(sid, []); sketchNum.set(sid, sketchNum.size + 1); }
    members.get(sid)!.push({ op, i });
  });

  const opRow = (op: OperationRecord, i: number, nested: boolean) => {
    const active = i < rollback && !op.suppressed;
    const cls = op.error ? "err" : op.suppressed ? "sup" : active ? "on" : "off";
    return (
      <div className={`op-row ${cls} ${nested ? "grouped" : ""}`} key={op.opId}>
        <span className="op-idx">{i + 1}</span>
        <span className="op-dot" />
        <span className="op-label" title={`${op.type} — click to roll back to here`} onClick={() => moveRollback(i + 1)}>
          {op.label}
          {op.error && <span className="op-err"> ⚠</span>}
        </span>
        <button className="op-mini" title={op.suppressed ? "Unsuppress" : "Suppress"} onClick={() => suppressOperation(op.opId, !op.suppressed)}>
          {op.suppressed ? "○" : "◉"}
        </button>
        <button className="op-mini danger" title="Delete operation" onClick={() => deleteOperation(op.opId)}>✕</button>
      </div>
    );
  };

  const renderedSketch = new Set<string>();

  return (
    <div className="panel timeline">
      <div className="panel-head">
        <span>Timeline</span>
        <div className="hist-btns">
          <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!session.canUndo()} onClick={undo}>↶</button>
          <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!session.canRedo()} onClick={redo}>↷</button>
        </div>
      </div>
      <div className="timeline-list">
        {ops.length === 0 && <div className="muted">No operations yet.</div>}
        {ops.map((op, i) => {
          const sid = ownerSketch(op);
          if (!sid) return opRow(op, i, false);
          if (renderedSketch.has(sid)) return null; // already drawn under its header
          renderedSketch.add(sid);

          const group = members.get(sid)!;
          const sk = session.doc.sketches[sid];
          const planeLabel = sk ? (sk.planeId === "custom" ? "face" : sk.planeId) : "—";
          const anyErr = group.some((m) => m.op.error);
          const anyActive = group.some((m) => m.i < rollback && !m.op.suppressed);
          const openNow = isOpen(sid);

          return (
            <div key={`sk-${sid}`} className="sketch-group">
              <div className={`group-head ${anyErr ? "err" : anyActive ? "on" : "off"}`}>
                <button className="group-caret" onClick={() => toggle(sid)} title={openNow ? "Collapse" : "Expand"}>
                  {openNow ? "▾" : "▸"}
                </button>
                <span className="group-glyph">✎</span>
                <span className="group-name" onClick={() => toggle(sid)}>
                  Sketch {sketchNum.get(sid)} <span className="group-sub">· {planeLabel}</span>
                  {anyErr && <span className="op-err"> ⚠</span>}
                </span>
                <span className="group-count">{group.length}</span>
              </div>
              {openNow && group.map((m) => opRow(m.op, m.i, true))}
            </div>
          );
        })}
        {rollback < ops.length && (
          <button className="rollback-tip" onClick={() => moveRollback(ops.length)}>▸ roll forward to latest</button>
        )}
      </div>
    </div>
  );
}
