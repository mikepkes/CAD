import { useStore } from "../model/store";
import { profileChoices } from "../model/featureTools";

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
  const extent = useStore((s) => s.extrudeExtent);
  const toFace = useStore((s) => s.extrudeToFace);
  const doc = useStore((s) => s.session.doc);
  useStore((s) => s.rev);
  const hasBody = Object.keys(doc.features).length > 0;
  const reverse = useStore((s) => s.extrudeReverse);
  // only sketches that can be extruded, by the names the browser shows (M11)
  const profiles = profileChoices(doc, target);

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
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
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
            <span>Extent</span>
            <select value={extent} onChange={(e) => S().setExtrudeExtent(e.target.value as "distance" | "toFace" | "throughAll")} title="A distance, through everything, or up to a face that it then follows">
              <option value="distance">Distance</option>
              <option value="throughAll">Through all</option>
              <option value="toFace">To face</option>
            </select>
          </label>
          {extent === "distance" ? (
            <label className="extrude-row">
              <span>Distance</span>
              <input value={distance} onChange={(e) => S().setExtrudeDistanceExpr(e.target.value)} spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") void S().commitExtrude(); e.stopPropagation(); }} autoFocus />
            </label>
          ) : extent === "toFace" ? (
            <div className="extrude-row">
              <span>To</span>
              <span className="extrude-region">{toFace ? `the face, ${distance} mm` : "click a face"}</span>
            </div>
          ) : (
            <div className="extrude-row">
              <span>Depth</span>
              <span className="extrude-region">past every body</span>
            </div>
          )}
          <label className="extrude-row">
            <span>Operation</span>
            <select value={operation} onChange={(e) => S().setExtrudeOperation(e.target.value as "new" | "join" | "cut" | "intersect")}>
              <option value="new">New body</option>
              <option value="join" disabled={!hasBody}>Join</option>
              <option value="cut" disabled={!hasBody}>Cut</option>
              <option value="intersect" disabled={!hasBody}>Intersect</option>
            </select>
          </label>
          {extent !== "toFace" && (
            <label className="extrude-row checkbox">
              <input type="checkbox" checked={symmetric} onChange={(e) => S().setExtrudeSymmetric(e.target.checked)} />
              <span>Symmetric</span>
            </label>
          )}
          {extent !== "toFace" && !symmetric && (
            <label className="extrude-row checkbox">
              <input type="checkbox" checked={reverse} onChange={(e) => useStore.setState({ extrudeReverse: e.target.checked })} />
              <span>Reverse (the other side of the sketch)</span>
            </label>
          )}
        </>
      )}
      <div className="extrude-foot">
        <button className="btn ghost" onClick={() => S().closeExtrude()}>Cancel</button>
        <button className="btn primary" disabled={!target || (extent === "toFace" && !toFace)} onClick={() => void S().commitExtrude()}>Extrude</button>
      </div>
    </div>
  );
}
