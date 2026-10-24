import { useState } from "react";
import { useStore } from "../model/store";

export function TimelinePanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const suppressOperation = useStore((s) => s.suppressOperation);
  const deleteOperation = useStore((s) => s.deleteOperation);
  const moveRollback = useStore((s) => s.moveRollback);
  const createTimelineGroup = useStore((s) => s.createTimelineGroup);
  const renameTimelineGroup = useStore((s) => s.renameTimelineGroup);
  const toggleTimelineGroup = useStore((s) => s.toggleTimelineGroup);
  const ungroupTimeline = useStore((s) => s.ungroupTimeline);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const toggleCheck = (id: string) =>
    setChecked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const ops = session.timeline;
  const rollback = session.rollbackIndex;
  const groups = session.doc.timelineGroups;
  const groupOf = new Map<string, (typeof groups)[number]>();
  for (const g of groups) for (const id of g.opIds) groupOf.set(id, g);
  const headerShown = new Set<string>();

  const makeGroup = () => {
    createTimelineGroup([...checked]);
    setChecked(new Set());
  };

  const opRow = (op: (typeof ops)[number], i: number, inGroup: boolean) => {
    const active = i < rollback && !op.suppressed;
    const cls = op.error ? "err" : op.suppressed ? "sup" : active ? "on" : "off";
    return (
      <div className={`op-row ${cls} ${inGroup ? "grouped" : ""}`} key={op.opId}>
        <input
          type="checkbox"
          className="op-check"
          checked={checked.has(op.opId)}
          onChange={() => toggleCheck(op.opId)}
          title="Select for grouping"
        />
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

  return (
    <div className="panel timeline">
      <div className="panel-head">
        <span>Timeline</span>
        <div className="hist-btns">
          {checked.size > 0 && (
            <button className="btn small" title="Group the selected operations" onClick={makeGroup}>
              ⊞ Group ({checked.size})
            </button>
          )}
          <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!session.canUndo()} onClick={undo}>↶</button>
          <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!session.canRedo()} onClick={redo}>↷</button>
        </div>
      </div>
      <div className="timeline-list">
        {ops.length === 0 && <div className="muted">No operations yet.</div>}
        {ops.map((op, i) => {
          const g = groupOf.get(op.opId);
          if (!g) return opRow(op, i, false);
          const nodes = [];
          if (!headerShown.has(g.id)) {
            headerShown.add(g.id);
            nodes.push(
              <div className="group-head" key={`h-${g.id}`}>
                <button className="group-caret" onClick={() => toggleTimelineGroup(g.id)} title={g.collapsed ? "Expand" : "Collapse"}>
                  {g.collapsed ? "▸" : "▾"}
                </button>
                <span
                  className="group-name"
                  title="Double-click to rename"
                  onDoubleClick={() => { const n = prompt("Group name", g.name); if (n != null && n.trim()) renameTimelineGroup(g.id, n.trim()); }}
                >
                  {g.name}
                </span>
                <span className="group-count">{g.opIds.length}</span>
                <button className="op-mini" title="Ungroup" onClick={() => ungroupTimeline(g.id)}>⊟</button>
              </div>
            );
          }
          if (!g.collapsed) nodes.push(opRow(op, i, true));
          return <div key={`w-${op.opId}`}>{nodes}</div>;
        })}
        {rollback < ops.length && (
          <button className="rollback-tip" onClick={() => moveRollback(ops.length)}>▸ roll forward to latest</button>
        )}
      </div>
    </div>
  );
}
