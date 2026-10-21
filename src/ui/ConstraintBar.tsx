import { activeSketch, useStore } from "../model/store";
import { availableOps, Op } from "../model/selectionOps";

export function ConstraintBar() {
  const mode = useStore((s) => s.mode);
  const dispatch = useStore((s) => s.dispatch);
  const clearSelection = useStore((s) => s.clearSelection);
  const sk = useStore(activeSketch);
  const selection = useStore((s) => s.selection);

  if (mode !== "sketch" || !sk) return null;

  const { geometric, dimensions, modify } = availableOps(sk, selection);
  const nothing = geometric.length === 0 && dimensions.length === 0 && modify.length === 0;

  const apply = async (op: Op) => {
    await dispatch(op.command.type, op.command.params, { rejectOnConflict: true });
    clearSelection();
  };

  return (
    <div className="constraint-bar">
      <div className="cb-section">
        <span className="cb-title">Constraints</span>
        {geometric.length === 0 && <span className="cb-empty">—</span>}
        {geometric.map((op) => (
          <button key={op.id} className="chip" title={op.hint} onClick={() => apply(op)}>
            <span className="chip-glyph">{op.glyph}</span>
            {op.label}
          </button>
        ))}
      </div>
      <div className="cb-section">
        <span className="cb-title">Dimensions</span>
        {dimensions.length === 0 && <span className="cb-empty">—</span>}
        {dimensions.map((op) => (
          <button key={op.id} className="chip dim" title={op.hint} onClick={() => apply(op)}>
            <span className="chip-glyph">{op.glyph}</span>
            {op.label}
          </button>
        ))}
      </div>
      {modify.length > 0 && (
        <div className="cb-section">
          <span className="cb-title">Modify</span>
          {modify.map((op) => (
            <button key={op.id} className="chip mod" title={op.hint} onClick={() => apply(op)}>
              <span className="chip-glyph">{op.glyph}</span>
              {op.label}
            </button>
          ))}
        </div>
      )}
      {nothing && (
        <div className="cb-hint">Select geometry (points, lines, circles) to apply constraints, dimensions &amp; modify tools.</div>
      )}
    </div>
  );
}
