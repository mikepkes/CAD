import { useStore } from "../model/store";
import type { CadDocument } from "../core/document";

/** Render one component node and its subtree (components nest; sketches are leaves). */
function ComponentNode({ doc, id, depth }: { doc: CadDocument; id: string; depth: number }) {
  const mode = useStore((s) => s.mode);
  const activeSketchId = useStore((s) => s.activeSketchId);
  const activeComponentId = useStore((s) => s.activeComponentId);
  const editSketch = useStore((s) => s.editSketch);
  const finishSketch = useStore((s) => s.finishSketch);
  const activateComponent = useStore((s) => s.activateComponent);

  const c = doc.components[id];
  if (!c) return null;
  const isRoot = c.parentId === null;
  const active = activeComponentId === id;
  const pos = c.transform?.position;
  const placed = !!(pos && (pos.x || pos.y || pos.z));

  return (
    <>
      <div
        className={`tree-row ${active ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => activateComponent(id)}
        title={active ? "Active component — new sketches land here" : "Activate component"}
      >
        <span className="tree-icon">{isRoot ? "▣" : "⬡"}</span>
        <span className="tree-label">
          {c.name}
          {placed && <span className="muted-inline"> · ({pos!.x}, {pos!.y}, {pos!.z})</span>}
        </span>
        {active && !isRoot && <span className="dof-dot ok" />}
      </div>
      {c.sketches.map((sid) => {
        const sk = doc.sketches[sid];
        if (!sk) return null;
        const editing = mode === "sketch" && activeSketchId === sid;
        const st = sk.status;
        return (
          <div
            key={sid}
            className={`tree-row sketch ${editing ? "active" : ""}`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            onClick={() => (editing ? finishSketch() : editSketch(sid))}
            title={st.message}
          >
            <span className="tree-icon">✎</span>
            <span className="tree-label">
              {sk.name} <span className="muted-inline">· {sk.planeId}</span>
            </span>
            <span className={`dof-dot ${st.fullyConstrained ? "ok" : st.conflicting ? "bad" : "warn"}`} />
          </div>
        );
      })}
      {c.children.map((childId) => (
        <ComponentNode key={childId} doc={doc} id={childId} depth={depth + 1} />
      ))}
    </>
  );
}

export function BrowserPanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev); // re-render on changes
  const startSketch = useStore((s) => s.startSketch);
  const editJointValue = useStore((s) => s.editJointValue);
  const doc = session.doc;
  const root = doc.components[doc.rootComponentId];
  const datums = Object.values(doc.planes);
  const empty = (root?.sketches.length ?? 0) === 0 && (root?.children.length ?? 0) === 0 && datums.length === 0;

  return (
    <div className="panel browser">
      <div className="panel-head">
        <span>Browser</span>
      </div>
      <div className="tree">
        {datums.map((d) => (
          <div
            key={d.id}
            className="tree-row"
            style={{ paddingLeft: 22 }}
            onClick={() => startSketch(d.id)}
            title={d.error ? `Unresolved: ${d.error}` : `Offset ${d.offsetExpr} from ${d.base} — click to sketch on it`}
          >
            <span className="tree-icon" style={{ color: "#c9a227" }}>▱</span>
            <span className="tree-label">
              {d.name} <span className="muted-inline">· {d.base} +{d.offsetExpr}</span>
            </span>
            {d.error && <span className="dof-dot bad" />}
          </div>
        ))}
        <ComponentNode doc={doc} id={doc.rootComponentId} depth={0} />
        {Object.values(doc.joints).map((j) => (
          <div key={j.id} className="tree-row" style={{ paddingLeft: 22 }} title={j.error ? `Unresolved: ${j.error}` : `${j.kind} joint: ${doc.components[j.moved]?.name ?? j.moved} → ${doc.components[j.base]?.name ?? j.base}`}>
            <span className="tree-icon" style={{ color: "#8fd3ff" }}>⚙</span>
            <span className="tree-label">
              {j.name} <span className="muted-inline">· {j.kind}</span>
            </span>
            {j.kind !== "rigid" && (
              <input
                className="dim-expr"
                style={{ width: 54 }}
                defaultValue={j.valueExpr}
                key={j.id + j.valueExpr}
                title={j.kind === "revolute" ? "Angle (degrees)" : "Distance"}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => { if (e.target.value !== j.valueExpr) editJointValue(j.id, e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
            )}
            {j.error && <span className="dof-dot bad" />}
          </div>
        ))}
        {empty && Object.keys(doc.joints).length === 0 && <div className="muted">No sketches yet.</div>}
      </div>
    </div>
  );
}
