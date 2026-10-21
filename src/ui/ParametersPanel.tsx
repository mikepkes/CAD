import { useStore } from "../model/store";
import { isValidParamName } from "../model/parameters";

export function ParametersPanel() {
  const session = useStore((s) => s.session);
  useStore((s) => s.rev);
  const addParameter = useStore((s) => s.addParameter);
  const setParameterExpr = useStore((s) => s.setParameterExpr);
  const renameParameter = useStore((s) => s.renameParameter);
  const deleteParameter = useStore((s) => s.deleteParameter);

  const parameters = session.doc.parameters;

  return (
    <div className="panel parameters">
      <div className="panel-head">
        <span>Parameters</span>
        <button className="icon-btn" title="Add parameter" onClick={() => addParameter("d")}>
          ＋
        </button>
      </div>
      <div className="param-table">
        <div className="param-row header">
          <span>Name</span>
          <span>Expression</span>
          <span>Value</span>
          <span />
        </div>
        {parameters.length === 0 && <div className="param-empty">No parameters yet.</div>}
        {parameters.map((p) => (
          <div className={`param-row ${p.error ? "error" : ""}`} key={p.id}>
            <input
              className="param-name"
              defaultValue={p.name}
              key={`n${p.id}${p.name}`}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== p.name && isValidParamName(v)) renameParameter(p.name, v);
                else e.target.value = p.name;
              }}
            />
            <input
              className="param-expr"
              defaultValue={p.expr}
              key={`e${p.id}${p.expr}`}
              onBlur={(e) => {
                if (e.target.value !== p.expr) setParameterExpr(p.name, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="param-value" title={p.error}>
              {p.error ? "⚠" : p.value.toFixed(3)}
            </span>
            <button className="icon-btn danger" title="Delete" onClick={() => deleteParameter(p.name)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="param-foot">
        Use names in dimensions, e.g. <code>width</code>, <code>width/2</code>, <code>rad(30)</code>.
      </div>
    </div>
  );
}
