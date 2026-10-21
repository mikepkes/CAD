import { useStore } from "../model/store";

export function TimelinePanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const suppressOperation = useStore((s) => s.suppressOperation);
  const deleteOperation = useStore((s) => s.deleteOperation);
  const moveRollback = useStore((s) => s.moveRollback);

  const ops = session.timeline;
  const rollback = session.rollbackIndex;

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
          const active = i < rollback && !op.suppressed;
          const cls = op.error ? "err" : op.suppressed ? "sup" : active ? "on" : "off";
          return (
            <div className={`op-row ${cls}`} key={op.opId}>
              <span className="op-idx">{i + 1}</span>
              <span className="op-dot" />
              <span
                className="op-label"
                title={`${op.type} — click to roll back to here`}
                onClick={() => moveRollback(i + 1)}
              >
                {op.label}
                {op.error && <span className="op-err"> ⚠</span>}
              </span>
              <button
                className="op-mini"
                title={op.suppressed ? "Unsuppress" : "Suppress"}
                onClick={() => suppressOperation(op.opId, !op.suppressed)}
              >
                {op.suppressed ? "○" : "◉"}
              </button>
              <button className="op-mini danger" title="Delete operation" onClick={() => deleteOperation(op.opId)}>✕</button>
            </div>
          );
        })}
        {rollback < ops.length && (
          <button className="rollback-tip" onClick={() => moveRollback(ops.length)}>
            ▸ roll forward to latest
          </button>
        )}
      </div>
    </div>
  );
}
