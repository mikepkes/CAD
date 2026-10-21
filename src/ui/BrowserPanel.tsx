import { useStore } from "../model/store";

export function BrowserPanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev); // re-render on changes
  const activeSketchId = useStore((s) => s.activeSketchId);
  const mode = useStore((s) => s.mode);
  const editSketch = useStore((s) => s.editSketch);
  const finishSketch = useStore((s) => s.finishSketch);

  const doc = session.doc;
  const root = doc.components[doc.rootComponentId];

  return (
    <div className="panel browser">
      <div className="panel-head">
        <span>Browser</span>
      </div>
      <div className="tree">
        <div className="tree-row active" style={{ paddingLeft: 8 }}>
          <span className="tree-icon">▣</span>
          <span className="tree-label">{root?.name ?? "Root Component"}</span>
        </div>
        {(root?.sketches ?? []).map((sid) => {
          const sk = doc.sketches[sid];
          if (!sk) return null;
          const editing = mode === "sketch" && activeSketchId === sid;
          const st = sk.status;
          return (
            <div
              key={sid}
              className={`tree-row sketch ${editing ? "active" : ""}`}
              style={{ paddingLeft: 22 }}
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
        {(root?.sketches ?? []).length === 0 && <div className="muted">No sketches yet.</div>}
      </div>
    </div>
  );
}
