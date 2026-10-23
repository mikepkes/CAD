import { useStore, activeSketch } from "../model/store";
import { availableOps, Op } from "../model/selectionOps";

// Right-click context menu: surfaces the same selection-aware operations as the
// ConstraintBar (geometric, dimensions, modify) plus Delete, at the cursor.
export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const close = useStore((s) => s.closeContextMenu);
  const sk = useStore(activeSketch);
  const selection = useStore((s) => s.selection);
  const dispatch = useStore((s) => s.dispatch);
  const beginInlineEdit = useStore((s) => s.beginInlineEdit);
  const deleteSelected = useStore((s) => s.deleteSelected);
  useStore((s) => s.rev);

  if (!menu || !sk) return null;
  const { geometric, dimensions, modify } = availableOps(sk, selection);

  const runDim = (op: Op) => {
    beginInlineEdit({
      mode: "new",
      params: op.command.params,
      value: String(op.command.params.expression ?? ""),
      screen: { x: menu.x, y: menu.y },
    });
    close();
  };
  const run = (op: Op) => { void dispatch(op.command.type, op.command.params, { rejectOnConflict: true }); close(); };

  const section = (title: string, ops: Op[], onPick: (op: Op) => void) =>
    ops.length ? (
      <>
        <div className="ctx-title">{title}</div>
        {ops.map((op) => (
          <button key={op.id} className="ctx-item" title={op.hint} onClick={() => onPick(op)}>
            <span className="ctx-glyph">{op.glyph}</span> {op.label}
          </button>
        ))}
      </>
    ) : null;

  const empty = !geometric.length && !dimensions.length && !modify.length;

  return (
    <>
      <div className="ctx-backdrop" onPointerDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
        {section("Constrain", geometric, run)}
        {section("Dimension", dimensions, runDim)}
        {section("Modify", modify, run)}
        {selection.length > 0 && (
          <>
            {!empty && <div className="ctx-sep" />}
            <button className="ctx-item danger" onClick={() => { void deleteSelected(); close(); }}>
              <span className="ctx-glyph">✕</span> Delete
            </button>
          </>
        )}
        {empty && selection.length === 0 && <div className="ctx-empty">Select geometry first</div>}
      </div>
    </>
  );
}
