// The modelling panels beside Extrude: Revolve (a profile turned about a sketch
// line or a world axis), Shell (click the faces to open), Pattern (linear or
// circular copies of a body) and Fillet/Chamfer by picked edges. Each is one
// store session (`featureTool`); clicks in the viewport add faces or edges to it
// (interactions.ts), and the decisions are in model/featureTools.ts.

import { useStore } from "../model/store";
import { useUi } from "../model/concepts/uiState";
import { defaultRevolveAxis, profileChoices, revolveLineChoices, worldAxisInSketch, WORLD_AXES, type FeatureTool, type WorldAxis } from "../model/featureTools";

const AXES = Object.keys(WORLD_AXES) as WorldAxis[];

export function FeatureToolPanel() {
  const tool = useStore((s) => s.featureTool);
  const doc = useStore((s) => s.session.doc);
  const solids = useStore((s) => s.solids);
  useStore((s) => s.rev);
  if (!tool) return null;
  const S = useStore.getState;
  const patch = (p: Partial<FeatureTool>) => S().patchFeatureTool(p as Record<string, unknown>);
  const commit = async () => {
    const id = await S().commitFeatureTool();
    if (id) { if (!useUi.getState().panels.workbench) useUi.getState().togglePanel("workbench", true); useUi.getState().setOpenFeature(id); }
  };
  const onEnter = (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === "Enter") void commit(); if (e.key === "Escape") S().closeFeatureTool(); };
  const bodyName = (id: string | null) => (id ? doc.features[id]?.name ?? solids[id]?.name ?? id : "the latest body");
  const hasBody = Object.keys(doc.features).length > 0;

  let title = "", verb = "", body: React.ReactNode = null;
  if (tool.kind === "revolve") {
    title = "Revolve"; verb = "Revolve";
    const sk = tool.sketch ? doc.sketches[tool.sketch] : undefined;
    const lines = sk ? revolveLineChoices(sk) : [];
    const axisValue = !tool.axis ? "" : "line" in tool.axis ? `line:${tool.axis.line}` : `world:${tool.axis.world}`;
    body = (
      <>
        <label className="extrude-row">
          <span>Profile</span>
          <select value={tool.sketch ?? ""} onChange={(e) => { const next = doc.sketches[e.target.value]; patch({ sketch: e.target.value, axis: next ? defaultRevolveAxis(next) : null }); }}>
            {profileChoices(doc, tool.sketch).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="extrude-row">
          <span>Axis</span>
          <select value={axisValue} onChange={(e) => { const [k, v] = e.target.value.split(":"); patch({ axis: k === "line" ? { line: v } : { world: v as WorldAxis } }); }}>
            {!tool.axis && <option value="">choose an axis…</option>}
            {lines.map((l) => <option key={l.id} value={`line:${l.id}`}>{l.label}</option>)}
            {AXES.map((a) => <option key={a} value={`world:${a}`} disabled={!sk || !worldAxisInSketch(sk, a)}>{a} axis{sk && !worldAxisInSketch(sk, a) ? " (not in this plane)" : ""}</option>)}
          </select>
        </label>
        <label className="extrude-row">
          <span>Angle</span>
          <input value={tool.angle} spellCheck={false} aria-label="Angle (degrees)" onChange={(e) => patch({ angle: e.target.value })} onKeyDown={onEnter} />
        </label>
        <label className="extrude-row">
          <span>Operation</span>
          <select value={tool.operation} onChange={(e) => patch({ operation: e.target.value as "new" })}>
            <option value="new">New body</option>
            <option value="join" disabled={!hasBody}>Join</option>
            <option value="cut" disabled={!hasBody}>Cut</option>
            <option value="intersect" disabled={!hasBody}>Intersect</option>
          </select>
        </label>
      </>
    );
  } else if (tool.kind === "shell") {
    title = "Shell"; verb = "Shell";
    body = (
      <>
        <p className="field-note">Click the faces to open on the model (click again to keep one closed).</p>
        <div className="extrude-row"><span>Body</span><span className="extrude-region">{bodyName(tool.body)}</span></div>
        <div className="extrude-row"><span>Open</span><span className="extrude-region" aria-live="polite">{tool.faces.length ? `${tool.faces.length} face${tool.faces.length === 1 ? "" : "s"}` : "none yet"}</span></div>
        <label className="extrude-row">
          <span>Wall</span>
          <input value={tool.thickness} spellCheck={false} aria-label="Wall thickness" onChange={(e) => patch({ thickness: e.target.value })} onKeyDown={onEnter} />
        </label>
      </>
    );
  } else if (tool.kind === "pattern") {
    title = "Pattern"; verb = "Pattern";
    const bodies = Object.values(solids).filter((b) => b.mesh);
    body = (
      <>
        <label className="extrude-row">
          <span>Body</span>
          <select value={tool.body ?? ""} onChange={(e) => patch({ body: e.target.value })}>
            {bodies.map((b) => <option key={b.featureId} value={b.featureId}>{bodyName(b.featureId)}</option>)}
          </select>
        </label>
        <label className="extrude-row">
          <span>Kind</span>
          <select value={tool.mode} onChange={(e) => patch({ mode: e.target.value as "linear" })}>
            <option value="linear">Along a line</option>
            <option value="circular">Around an axis</option>
          </select>
        </label>
        <label className="extrude-row">
          <span>Count</span>
          <input value={tool.count} spellCheck={false} aria-label="Count" onChange={(e) => patch({ count: e.target.value })} onKeyDown={onEnter} />
        </label>
        {tool.mode === "linear" ? (
          <>
            <label className="extrude-row">
              <span>Direction</span>
              <select value={tool.direction} onChange={(e) => patch({ direction: e.target.value as WorldAxis })}>
                {AXES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="extrude-row">
              <span>Spacing</span>
              <input value={tool.spacing} spellCheck={false} aria-label="Spacing" onChange={(e) => patch({ spacing: e.target.value })} onKeyDown={onEnter} />
            </label>
          </>
        ) : (
          <>
            <label className="extrude-row">
              <span>Axis</span>
              <select value={tool.axis} onChange={(e) => patch({ axis: e.target.value as WorldAxis })}>
                {AXES.map((a) => <option key={a} value={a}>{a} through the origin</option>)}
              </select>
            </label>
            <label className="extrude-row">
              <span>Angle</span>
              <input value={tool.angle} placeholder="even, all round" spellCheck={false} aria-label="Angle between copies" onChange={(e) => patch({ angle: e.target.value })} onKeyDown={onEnter} />
            </label>
          </>
        )}
      </>
    );
  } else {
    const round = tool.blend === "fillet";
    title = round ? "Fillet edges" : "Chamfer edges"; verb = round ? "Fillet" : "Chamfer";
    body = (
      <>
        <p className="field-note">Click edges on the model to {round ? "round" : "bevel"} them (click again to drop one).</p>
        <div className="extrude-row"><span>Edges</span><span className="extrude-region" aria-live="polite">{tool.edges.length ? `${tool.edges.length} on ${bodyName(tool.body)}` : "none yet"}</span></div>
        <label className="extrude-row">
          <span>{round ? "Radius" : "Distance"}</span>
          <input value={tool.size} spellCheck={false} aria-label={round ? "Radius" : "Distance"} onChange={(e) => patch({ size: e.target.value })} onKeyDown={onEnter} />
        </label>
      </>
    );
  }
  const ready = tool.kind === "shell" ? tool.faces.length > 0 : tool.kind === "edges" ? tool.edges.length > 0 : tool.kind === "revolve" ? !!tool.sketch && !!tool.axis : !!tool.body;

  return (
    <div className="extrude-panel tool-panel" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
      <div className="extrude-head">{title}</div>
      {body}
      <div className="extrude-foot">
        <button className="btn ghost" onClick={() => S().closeFeatureTool()}>Cancel</button>
        <button className="btn primary" disabled={!ready} onClick={() => void commit()}>{verb}</button>
      </div>
    </div>
  );
}
