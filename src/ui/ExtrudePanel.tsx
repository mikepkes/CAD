import { useState, useEffect } from "react";
import { useStore } from "../model/store";

// Unified extrude session. Invoke Extrude, then click a sketch region or a
// planar face in the viewport to choose what to extrude; set distance and how
// it combines with existing bodies (new / join / cut), Fusion-style.
export function ExtrudePanel() {
  const active = useStore((s) => s.extrudeActive);
  const target = useStore((s) => s.extrudeTarget);
  const region = useStore((s) => s.extrudeRegion);
  const doc = useStore((s) => s.session.doc);
  useStore((s) => s.rev);
  const hasBody = Object.keys(doc.features).length > 0;
  const sketches = Object.values(doc.sketches);

  const [distance, setDistance] = useState("10");
  const [operation, setOperation] = useState<"new" | "join" | "cut">("new");
  const [symmetric, setSymmetric] = useState(false);

  // When the picked profile changes, reset distance and default the operation
  // (a sketch on a face with a body present → Join, like F360).
  useEffect(() => {
    if (!target) return;
    const sk = doc.sketches[target];
    setOperation(hasBody && sk?.planeId === "custom" ? "join" : "new");
    setDistance("10");
    setSymmetric(false);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return null;

  const commit = async () => {
    if (!target) return;
    await useStore.getState().extrudeSketch(target, distance.trim() || "10", {
      operation,
      symmetric,
      region: region ?? undefined,
    });
    useStore.getState().closeExtrude();
  };

  return (
    <div className="extrude-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="extrude-head">⬆ Extrude</div>
      {!target ? (
        <p className="field-note">Click a sketch <strong>region</strong> or a planar <strong>face</strong> in the viewport to choose what to extrude.</p>
      ) : (
        <>
          <label className="extrude-row">
            <span>Profile</span>
            <select
              value={target}
              onChange={(e) => useStore.setState({ extrudeTarget: e.target.value, extrudeRegion: null })}
            >
              {sketches.map((s) => (
                <option key={s.id} value={s.id}>{s.id} · {s.planeId === "custom" ? "face" : s.planeId}</option>
              ))}
            </select>
          </label>
          <div className="extrude-row">
            <span>Region</span>
            <span className="extrude-region">
              {region ? "1 picked" : "all regions"}
              {region && <button className="linklike" onClick={() => useStore.getState().setExtrudeRegion(null)}>use all</button>}
            </span>
          </div>
          <label className="extrude-row">
            <span>Distance</span>
            <input value={distance} onChange={(e) => setDistance(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") void commit(); e.stopPropagation(); }} autoFocus />
          </label>
          <label className="extrude-row">
            <span>Operation</span>
            <select value={operation} onChange={(e) => setOperation(e.target.value as "new" | "join" | "cut")}>
              <option value="new">New body</option>
              <option value="join" disabled={!hasBody}>Join</option>
              <option value="cut" disabled={!hasBody}>Cut</option>
            </select>
          </label>
          <label className="extrude-row checkbox">
            <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
            <span>Symmetric</span>
          </label>
        </>
      )}
      <div className="extrude-foot">
        <button className="btn ghost" onClick={() => useStore.getState().closeExtrude()}>Cancel</button>
        <button className="btn primary" disabled={!target} onClick={() => void commit()}>Extrude</button>
      </div>
    </div>
  );
}
