import { useStore } from "../model/store";

// Unified extrude session. Invoke Extrude, then click a sketch region or a
// planar face in the viewport to choose what to extrude; drag the arrow handle
// or type a distance (live preview), pick how it combines (new / join / cut),
// and commit. All params live in the store so the handle, panel and preview
// stay in sync.
export function ExtrudePanel() {
  const active = useStore((s) => s.extrudeActive);
  const target = useStore((s) => s.extrudeTarget);
  const region = useStore((s) => s.extrudeRegion);
  const distance = useStore((s) => s.extrudeDistanceExpr);
  const operation = useStore((s) => s.extrudeOperation);
  const symmetric = useStore((s) => s.extrudeSymmetric);
  const doc = useStore((s) => s.session.doc);
  useStore((s) => s.rev);
  const hasBody = Object.keys(doc.features).length > 0;
  const sketches = Object.values(doc.sketches);

  if (!active) return null;
  const S = useStore.getState;

  return (
    <div className="extrude-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="extrude-head">⬆ Extrude</div>
      {!target ? (
        <p className="field-note">Click a sketch <strong>region</strong> or a planar <strong>face</strong> in the viewport to choose what to extrude.</p>
      ) : (
        <>
          <label className="extrude-row">
            <span>Profile</span>
            <select value={target} onChange={(e) => useStore.setState({ extrudeTarget: e.target.value, extrudeRegion: null })}>
              {sketches.map((s) => (
                <option key={s.id} value={s.id}>{s.id} · {s.planeId === "custom" ? "face" : s.planeId}</option>
              ))}
            </select>
          </label>
          <div className="extrude-row">
            <span>Region</span>
            <span className="extrude-region">
              {region ? "1 picked" : "all regions"}
              {region && <button className="linklike" onClick={() => S().setExtrudeRegion(null)}>use all</button>}
            </span>
          </div>
          <label className="extrude-row">
            <span>Distance</span>
            <input value={distance} onChange={(e) => S().setExtrudeDistanceExpr(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") void S().commitExtrude(); e.stopPropagation(); }} autoFocus />
          </label>
          <label className="extrude-row">
            <span>Operation</span>
            <select value={operation} onChange={(e) => S().setExtrudeOperation(e.target.value as "new" | "join" | "cut" | "intersect")}>
              <option value="new">New body</option>
              <option value="join" disabled={!hasBody}>Join</option>
              <option value="cut" disabled={!hasBody}>Cut</option>
              <option value="intersect" disabled={!hasBody}>Intersect</option>
            </select>
          </label>
          <label className="extrude-row checkbox">
            <input type="checkbox" checked={symmetric} onChange={(e) => S().setExtrudeSymmetric(e.target.checked)} />
            <span>Symmetric</span>
          </label>
        </>
      )}
      <div className="extrude-foot">
        <button className="btn ghost" onClick={() => S().closeExtrude()}>Cancel</button>
        <button className="btn primary" disabled={!target} onClick={() => void S().commitExtrude()}>Extrude</button>
      </div>
    </div>
  );
}
