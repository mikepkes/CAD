import { useMemo, useState, useEffect } from "react";
import { useStore } from "../model/store";

// Unified extrude: pick a sketch (its region(s)) and a distance, and how it
// combines with existing bodies (new / join / cut) — Fusion-style. A sketch on
// a face with a body already present defaults to Join, like F360.
export function ExtrudePanel() {
  const target = useStore((s) => s.extrudeTarget);
  const doc = useStore((s) => s.session.doc);
  useStore((s) => s.rev);
  const hasBody = Object.keys(doc.features).length > 0;

  const sketches = useMemo(() => Object.values(doc.sketches), [doc]);
  const [sketchId, setSketchId] = useState(target ?? "");
  const [distance, setDistance] = useState("10");
  const [operation, setOperation] = useState<"new" | "join" | "cut">("new");
  const [symmetric, setSymmetric] = useState(false);

  useEffect(() => {
    if (!target) return;
    setSketchId(target);
    // Default to Join when extruding a face sketch onto an existing body.
    const sk = doc.sketches[target];
    const onFace = sk?.planeId === "custom";
    setOperation(hasBody && onFace ? "join" : "new");
    setDistance("10");
    setSymmetric(false);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;

  const commit = async () => {
    const id = sketchId || target;
    await useStore.getState().extrudeSketch(id, distance.trim() || "10", { operation, symmetric });
    useStore.getState().closeExtrude();
  };

  return (
    <div className="extrude-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="extrude-head">⬆ Extrude</div>
      <label className="extrude-row">
        <span>Profile</span>
        <select value={sketchId} onChange={(e) => setSketchId(e.target.value)}>
          {sketches.map((s) => (
            <option key={s.id} value={s.id}>{s.id} · {s.planeId === "custom" ? "face" : s.planeId}</option>
          ))}
        </select>
      </label>
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
      <div className="extrude-foot">
        <button className="btn ghost" onClick={() => useStore.getState().closeExtrude()}>Cancel</button>
        <button className="btn primary" onClick={() => void commit()}>Extrude</button>
      </div>
    </div>
  );
}
