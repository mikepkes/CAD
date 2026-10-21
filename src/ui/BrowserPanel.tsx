import { useStore } from "../model/store";

export function BrowserPanel() {
  const components = useStore((s) => s.components);
  const rootId = useStore((s) => s.rootComponentId);
  const sketches = useStore((s) => s.sketches);
  const activeComponentId = useStore((s) => s.activeComponentId);
  const activeSketchId = useStore((s) => s.activeSketchId);
  const mode = useStore((s) => s.mode);

  const addComponent = useStore((s) => s.addComponent);
  const setActiveComponent = useStore((s) => s.setActiveComponent);
  const editSketch = useStore((s) => s.editSketch);
  const finishSketch = useStore((s) => s.finishSketch);

  const renderComponent = (id: string, depth: number) => {
    const c = components[id];
    if (!c) return null;
    return (
      <div key={id}>
        <div
          className={`tree-row ${activeComponentId === id ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setActiveComponent(id)}
        >
          <span className="tree-icon">▣</span>
          <span className="tree-label">{c.name}</span>
          {activeComponentId === id && <span className="badge">active</span>}
        </div>
        {c.sketches.map((sid) => {
          const sk = sketches[sid];
          if (!sk) return null;
          const editing = mode === "sketch" && activeSketchId === sid;
          return (
            <div
              key={sid}
              className={`tree-row sketch ${editing ? "active" : ""}`}
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
              onClick={() => (editing ? finishSketch() : editSketch(sid))}
            >
              <span className="tree-icon">✎</span>
              <span className="tree-label">{sk.name}</span>
              <span className={`dof-dot ${sk.status.fullyConstrained ? "ok" : sk.status.conflicting ? "bad" : "warn"}`} />
            </div>
          );
        })}
        {c.children.map((ch) => renderComponent(ch, depth + 1))}
      </div>
    );
  };

  return (
    <div className="panel browser">
      <div className="panel-head">
        <span>Browser</span>
        <button className="icon-btn" title="New component" onClick={() => addComponent()}>
          ＋
        </button>
      </div>
      <div className="tree">{renderComponent(rootId, 0)}</div>
    </div>
  );
}
