import { useState } from "react";
import { useStore } from "../model/store";
import type { CadDocument, RoleRef } from "../core/document";
import { resolveParameters } from "../core/parameters";
import { compileExpr } from "../math/expr";

/** Resolve a count expression against the document's parameters for display. */
function resolvedCount(doc: CadDocument, expr: string, fallback: number): number {
  try {
    const { scope } = resolveParameters(doc.parameters);
    const v = compileExpr(expr).eval(scope);
    if (Number.isFinite(v)) return Math.max(1, Math.round(v));
  } catch { /* fall through */ }
  return Math.max(1, Math.round(fallback));
}

/** Component ids in `root`'s subtree (root included). */
function subtree(doc: CadDocument, root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !doc.components[id]) continue;
    seen.add(id);
    out.push(id);
    for (const ch of doc.components[id].children) stack.push(ch);
  }
  return out;
}

/** Add a named connector to a component (local coords). */
function ConnectorForm({ componentId, onClose }: { componentId: string; onClose: () => void }) {
  const addConnector = useStore((s) => s.addConnector);
  const [name, setName] = useState("");
  const [p, setP] = useState({ x: "0", y: "0", z: "0" });
  const submit = async () => {
    if (!name.trim()) return;
    await addConnector(componentId, name.trim(), { x: +p.x || 0, y: +p.y || 0, z: +p.z || 0 });
    onClose();
  };
  return (
    <div className="asm-form" onClick={(e) => e.stopPropagation()}>
      <input className="dim-expr" style={{ width: 70 }} placeholder="name" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); }} />
      {(["x", "y", "z"] as const).map((k) => (
        <input key={k} className="dim-expr" style={{ width: 38 }} placeholder={k} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); }} />
      ))}
      <button className="asm-btn" onClick={() => void submit()}>add</button>
    </div>
  );
}

/** One component node and its subtree (components nest; sketches & connectors are leaves). */
function ComponentNode({ doc, id, depth }: { doc: CadDocument; id: string; depth: number }) {
  const mode = useStore((s) => s.mode);
  const activeSketchId = useStore((s) => s.activeSketchId);
  const activeComponentId = useStore((s) => s.activeComponentId);
  const editSketch = useStore((s) => s.editSketch);
  const finishSketch = useStore((s) => s.finishSketch);
  const activateComponent = useStore((s) => s.activateComponent);
  const deleteConnector = useStore((s) => s.deleteConnector);
  const createComponentPattern = useStore((s) => s.createComponentPattern);
  const [addingConn, setAddingConn] = useState(false);

  const c = doc.components[id];
  if (!c) return null;
  const isRoot = c.parentId === null;
  const active = activeComponentId === id;
  const pos = c.transform?.position;
  const placed = !!(pos && (pos.x || pos.y || pos.z));
  const pad = 8 + depth * 14;
  const connectors = c.connectors ? Object.entries(c.connectors) : [];

  return (
    <>
      <div className={`tree-row ${active ? "active" : ""}`} style={{ paddingLeft: pad }} onClick={() => activateComponent(id)} title={active ? "Active component — new sketches land here" : "Activate component"}>
        <span className="tree-icon">{isRoot ? "▣" : "⬡"}</span>
        <span className="tree-label">
          {c.name}
          {placed && <span className="muted-inline"> · ({pos!.x}, {pos!.y}, {pos!.z})</span>}
        </span>
        {active && !isRoot && <span className="dof-dot ok" />}
      </div>

      {connectors.map(([cn, conn]) => (
        <div key={cn} className="tree-row" style={{ paddingLeft: pad + 14 }} title="Connector (joint origin), local coords">
          <span className="tree-icon" style={{ color: "#b48ead" }}>⊕</span>
          <span className="tree-label">{cn} <span className="muted-inline">· ({conn.origin.x}, {conn.origin.y}, {conn.origin.z})</span></span>
          <button className="asm-x" title="Delete connector" onClick={(e) => { e.stopPropagation(); void deleteConnector(id, cn); }}>✕</button>
        </div>
      ))}

      {c.sketches.map((sid) => {
        const sk = doc.sketches[sid];
        if (!sk) return null;
        const editing = mode === "sketch" && activeSketchId === sid;
        const st = sk.status;
        return (
          <div key={sid} className={`tree-row sketch ${editing ? "active" : ""}`} style={{ paddingLeft: pad + 14 }} onClick={() => (editing ? finishSketch() : editSketch(sid))} title={st.message}>
            <span className="tree-icon">✎</span>
            <span className="tree-label">{sk.name} <span className="muted-inline">· {sk.planeId}</span></span>
            <span className={`dof-dot ${st.fullyConstrained ? "ok" : st.conflicting ? "bad" : "warn"}`} />
          </div>
        );
      })}

      {active && !isRoot && (
        <div className="tree-row asm-actions" style={{ paddingLeft: pad + 14 }}>
          <button className="asm-btn" onClick={(e) => { e.stopPropagation(); setAddingConn((v) => !v); }}>+ connector</button>
          <button className="asm-btn" title="Duplicate this component (and its subtree) a parametric number of times, jointed" onClick={(e) => { e.stopPropagation(); void createComponentPattern(id, "1", `${c.name} pattern`); }}>+ pattern</button>
        </div>
      )}
      {addingConn && <div className="tree-row" style={{ paddingLeft: pad + 14 }}><ConnectorForm componentId={id} onClose={() => setAddingConn(false)} /></div>}

      {c.children.map((childId) => (
        <ComponentNode key={childId} doc={doc} id={childId} depth={depth + 1} />
      ))}
    </>
  );
}

const ROLES: RoleRef["role"][] = ["self", "prev", "root"];

/** Compact form to add a relational joint template to a pattern. */
function TemplateForm({ doc, patternId, sourceComps, onClose }: { doc: CadDocument; patternId: string; sourceComps: string[]; onClose: () => void }) {
  const createJointTemplate = useStore((s) => s.createJointTemplate);
  const first = sourceComps[0] ?? "";
  const portsOf = (cid: string) => Object.keys(doc.components[cid]?.connectors ?? {});
  const [kind, setKind] = useState<"revolute" | "slider" | "rigid">("revolute");
  const [base, setBase] = useState<{ role: RoleRef["role"]; component: string; port: string }>({ role: "root", component: first, port: portsOf(first)[0] ?? "" });
  const [moved, setMoved] = useState<{ role: RoleRef["role"]; component: string; port: string }>({ role: "self", component: first, port: portsOf(first)[0] ?? "" });
  const [axis, setAxis] = useState({ x: "0", y: "-1", z: "0" });
  const [value, setValue] = useState("0");
  const [appliesTo, setAppliesTo] = useState<"first" | "rest" | "all">("all");

  const refOf = (r: { role: RoleRef["role"]; component: string; port: string }): RoleRef =>
    r.role === "root" ? { role: "root", origin: { x: 0, y: 0, z: 0 } } : { role: r.role, component: r.component, port: r.port };

  const RefEditor = ({ label, r, set }: { label: string; r: typeof base; set: (v: typeof base) => void }) => (
    <div className="asm-ref">
      <span className="muted-inline" style={{ width: 38 }}>{label}</span>
      <select className="asm-sel" value={r.role} onChange={(e) => set({ ...r, role: e.target.value as RoleRef["role"] })}>
        {ROLES.map((ro) => <option key={ro} value={ro}>{ro}</option>)}
      </select>
      {r.role !== "root" && (
        <>
          <select className="asm-sel" value={r.component} onChange={(e) => set({ ...r, component: e.target.value, port: portsOf(e.target.value)[0] ?? "" })}>
            {sourceComps.map((cid) => <option key={cid} value={cid}>{doc.components[cid]?.name ?? cid}</option>)}
          </select>
          <select className="asm-sel" value={r.port} onChange={(e) => set({ ...r, port: e.target.value })}>
            {portsOf(r.component).map((pn) => <option key={pn} value={pn}>{pn}</option>)}
            {portsOf(r.component).length === 0 && <option value="">(no connectors)</option>}
          </select>
        </>
      )}
    </div>
  );

  const submit = async () => {
    await createJointTemplate(patternId, {
      kind, base: refOf(base), moved: refOf(moved),
      axis: { x: +axis.x || 0, y: +axis.y || 0, z: +axis.z || 0 },
      value, appliesTo,
    });
    onClose();
  };

  return (
    <div className="asm-tform" onClick={(e) => e.stopPropagation()}>
      <div className="asm-ref">
        <select className="asm-sel" value={kind} onChange={(e) => setKind(e.target.value as "revolute")}><option value="revolute">revolute</option><option value="slider">slider</option><option value="rigid">rigid</option></select>
        <select className="asm-sel" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as "all")} title="Which instances get this joint"><option value="all">all</option><option value="first">first (i=0)</option><option value="rest">rest (i≥1)</option></select>
      </div>
      <RefEditor label="base" r={base} set={setBase} />
      <RefEditor label="moved" r={moved} set={setMoved} />
      <div className="asm-ref">
        <span className="muted-inline" style={{ width: 38 }}>axis</span>
        {(["x", "y", "z"] as const).map((k) => <input key={k} className="dim-expr" style={{ width: 34 }} value={axis[k]} onChange={(e) => setAxis({ ...axis, [k]: e.target.value })} />)}
        <input className="dim-expr" style={{ width: 70 }} placeholder="value (uses i)" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <div className="asm-ref">
        <button className="asm-btn" onClick={() => void submit()}>add joint template</button>
        <button className="asm-btn" onClick={onClose}>cancel</button>
      </div>
    </div>
  );
}

/** Component patterns (jointed duplication) and their joint templates. */
function PatternsSection({ doc }: { doc: CadDocument }) {
  const editPatternCount = useStore((s) => s.editPatternCount);
  const deletePattern = useStore((s) => s.deletePattern);
  const editJointTemplateValue = useStore((s) => s.editJointTemplateValue);
  const setJointTemplateAppliesTo = useStore((s) => s.setJointTemplateAppliesTo);
  const deleteJointTemplate = useStore((s) => s.deleteJointTemplate);
  const [formFor, setFormFor] = useState<string | null>(null);

  const patterns = Object.values(doc.componentPatterns ?? {});
  if (!patterns.length) return null;

  return (
    <>
      <div className="tree-row section" style={{ paddingLeft: 10 }}><span className="tree-label muted">Patterns</span></div>
      {patterns.map((p) => {
        const comps = subtree(doc, p.source);
        const tmpls = Object.values(doc.jointTemplates ?? {}).filter((t) => t.patternId === p.id);
        return (
          <div key={p.id}>
            <div className="tree-row" style={{ paddingLeft: 22 }} title={`Jointed pattern of ${doc.components[p.source]?.name ?? p.source}`}>
              <span className="tree-icon" style={{ color: "#a3be8c" }}>❖</span>
              <span className="tree-label">{p.name} <span className="muted-inline">· ×{resolvedCount(doc, p.countExpr, p.count)}</span></span>
              <input className="dim-expr" style={{ width: 54 }} defaultValue={p.countExpr} key={p.id + p.countExpr} title="Instance count (expression)" onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== p.countExpr) void editPatternCount(p.id, e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <button className="asm-x" title="Delete pattern (and its joint templates)" onClick={(e) => { e.stopPropagation(); void deletePattern(p.id); }}>✕</button>
            </div>
            {tmpls.map((t) => (
              <div key={t.id} className="tree-row" style={{ paddingLeft: 36 }} title={`${t.kind}: ${t.moved.role}/${t.moved.port ?? "origin"} → ${t.base.role}/${t.base.port ?? "origin"}`}>
                <span className="tree-icon" style={{ color: "#8fd3ff" }}>⚙</span>
                <span className="tree-label muted-inline">{t.moved.port ?? t.moved.role}→{t.base.role === "root" ? "root" : (t.base.port ?? t.base.role)}</span>
                <select className="asm-sel" value={t.appliesTo} title="Which instances" onClick={(e) => e.stopPropagation()} onChange={(e) => void setJointTemplateAppliesTo(t.id, e.target.value as "all")}><option value="all">all</option><option value="first">first</option><option value="rest">rest</option></select>
                {t.kind !== "rigid" && (
                  <input className="dim-expr" style={{ width: 70 }} defaultValue={t.valueExpr} key={t.id + t.valueExpr} title="Value (degrees/length; may use i)" onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== t.valueExpr) void editJointTemplateValue(t.id, e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                )}
                <button className="asm-x" title="Delete joint template" onClick={(e) => { e.stopPropagation(); void deleteJointTemplate(t.id); }}>✕</button>
              </div>
            ))}
            <div className="tree-row" style={{ paddingLeft: 36 }}>
              <button className="asm-btn" onClick={() => setFormFor(formFor === p.id ? null : p.id)}>+ joint template</button>
            </div>
            {formFor === p.id && <div className="tree-row" style={{ paddingLeft: 36 }}><TemplateForm doc={doc} patternId={p.id} sourceComps={comps} onClose={() => setFormFor(null)} /></div>}
          </div>
        );
      })}
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
          <div key={d.id} className="tree-row" style={{ paddingLeft: 22 }} onClick={() => startSketch(d.id)} title={d.error ? `Unresolved: ${d.error}` : d.kind === "frame" ? `Through (${d.originExpr?.x}, ${d.originExpr?.y}, ${d.originExpr?.z}) — click to sketch on it` : `Offset ${d.offsetExpr} from ${d.base} — click to sketch on it`}>
            <span className="tree-icon" style={{ color: "#c9a227" }}>▱</span>
            <span className="tree-label">{d.name} <span className="muted-inline">· {d.kind === "frame" ? "point + normal" : `${d.base} +${d.offsetExpr}`}</span></span>
            {d.error && <span className="dof-dot bad" />}
          </div>
        ))}
        <ComponentNode doc={doc} id={doc.rootComponentId} depth={0} />
        {Object.values(doc.joints).map((j) => (
          <div key={j.id} className="tree-row" style={{ paddingLeft: 22 }} title={j.error ? `Unresolved: ${j.error}` : `${j.kind} joint: ${doc.components[j.moved]?.name ?? j.moved} → ${doc.components[j.base]?.name ?? j.base}`}>
            <span className="tree-icon" style={{ color: "#8fd3ff" }}>⚙</span>
            <span className="tree-label">{j.name} <span className="muted-inline">· {j.kind}</span></span>
            {j.kind !== "rigid" && (
              <input className="dim-expr" style={{ width: 54 }} defaultValue={j.valueExpr} key={j.id + j.valueExpr} title={j.kind === "revolute" ? "Angle (degrees)" : "Distance"} onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== j.valueExpr) editJointValue(j.id, e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            )}
            {j.error && <span className="dof-dot bad" />}
          </div>
        ))}
        <PatternsSection doc={doc} />
        {empty && Object.keys(doc.joints).length === 0 && <div className="muted">No sketches yet.</div>}
      </div>
    </div>
  );
}
