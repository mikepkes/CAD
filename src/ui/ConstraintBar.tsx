import { activeSketch, useStore } from "../model/store";
import { availableOps } from "../model/selectionOps";

export function ConstraintBar() {
  const store = useStore();
  const sk = activeSketch(store);
  if (store.mode !== "sketch" || !sk) return null;

  const { geometric, dimensions } = availableOps(sk, store.selection);
  const nothing = geometric.length === 0 && dimensions.length === 0;

  return (
    <div className="constraint-bar">
      <div className="cb-section">
        <span className="cb-title">Constraints</span>
        {geometric.length === 0 && <span className="cb-empty">—</span>}
        {geometric.map((op) => (
          <button key={op.id} className="chip" title={op.hint} onClick={() => op.apply(store)}>
            <span className="chip-glyph">{op.glyph}</span>
            {op.label}
          </button>
        ))}
      </div>
      <div className="cb-section">
        <span className="cb-title">Dimensions</span>
        {dimensions.length === 0 && <span className="cb-empty">—</span>}
        {dimensions.map((op) => (
          <button key={op.id} className="chip dim" title={op.hint} onClick={() => op.apply(store)}>
            <span className="chip-glyph">{op.glyph}</span>
            {op.label}
          </button>
        ))}
      </div>
      {nothing && (
        <div className="cb-hint">
          Select geometry (points, lines, circles) to apply constraints &amp; dimensions.
        </div>
      )}
    </div>
  );
}
