// The Browser panel's joints and couplings: a row per joint (its motion values,
// editable in place; a coupled value shows what drives it instead), a row per
// coupling (its ratio and direction), and the compact forms that add them —
// a joint between two components, drawn in place, and a coupling between two
// joints. Every change goes through the store as a joint.* operation.

import { useState } from "react";
import { useStore } from "../model/store";
import type { CadDocument, Coupling, Joint, JointDof } from "../core/document";

/** The motion values a form edits, as typed (expressions). */
export interface MotionValues { value: string; slide: string; tilt: string; heading: string; spin: string }
export const NO_MOTION: MotionValues = { value: "0", slide: "0", tilt: "0", heading: "0", spin: "0" };

/** The joint.create / joint.template parameters a kind takes from the typed values. */
export function motionParams(kind: string, v: MotionValues): Record<string, unknown> {
  if (kind === "rigid") return {};
  if (kind === "ball") return { ball: { tilt: v.tilt, heading: v.heading, spin: v.spin } };
  if (kind === "cylindrical") return { value: v.value, slide: v.slide };
  return { value: v.value };
}

const FIELD_TITLE: Record<keyof MotionValues, string> = {
  value: "Angle (degrees)", slide: "Travel along the axis (mm)", tilt: "Tilt: how far the axis leans (degrees)",
  heading: "Heading: which way it leans, round the axis from +X (degrees)", spin: "Spin: twist about its own axis (degrees)",
};

/** The value fields a kind has (none for rigid). */
const fieldsOf = (kind: string): (keyof MotionValues)[] =>
  kind === "rigid" ? [] : kind === "ball" ? ["tilt", "heading", "spin"] : kind === "cylindrical" ? ["value", "slide"] : ["value"];

/** Inputs for a kind's motion values. */
export function MotionFields({ kind, v, set, hint }: { kind: string; v: MotionValues; set: (v: MotionValues) => void; hint?: string }) {
  const fields = fieldsOf(kind);
  if (!fields.length) return null;
  return (
    <div className="asm-ref">
      <span className="muted-inline" style={{ width: 38 }}>{kind === "ball" ? "pose" : "value"}</span>
      {fields.map((k) => (
        <input key={k} className="dim-expr" style={{ width: fields.length > 1 ? 46 : 70 }} placeholder={`${k === "value" ? (kind === "slider" ? "travel" : "angle") : k}${hint ? ` (${hint})` : ""}`}
          title={k === "value" && kind === "slider" ? "Travel (mm)" : FIELD_TITLE[k]} value={v[k]} onChange={(e) => set({ ...v, [k]: e.target.value })} />
      ))}
    </div>
  );
}

const NEW_KINDS = ["revolute", "slider", "cylindrical", "ball", "rigid"] as const;

/** Add a joint between two components drawn in place: both connectors at one point. */
export function JointForm({ doc, onClose }: { doc: CadDocument; onClose: () => void }) {
  const createJoint = useStore((s) => s.createJoint);
  const placed = new Set(Object.values(doc.joints).filter((j) => !j.closes && j.kind !== "beam").map((j) => j.moved));
  const comps = Object.values(doc.components);
  const free = comps.filter((c) => c.id !== doc.rootComponentId && !placed.has(c.id));
  const [kind, setKind] = useState<(typeof NEW_KINDS)[number]>("revolute");
  const [base, setBase] = useState(doc.rootComponentId);
  const [moved, setMoved] = useState(free[0]?.id ?? "");
  const [at, setAt] = useState({ x: "0", y: "0", z: "0" });
  const [axis, setAxis] = useState({ x: "0", y: "0", z: "1" });
  const [motion, setMotion] = useState<MotionValues>(NO_MOTION);
  const [lim, setLim] = useState({ min: "", max: "" });
  // the stop the form offers: a slide's travel, a ball's cone, else the angle
  const limDof: JointDof | null = kind === "rigid" ? null : kind === "ball" ? "tilt" : kind === "cylindrical" ? "slide" : "value";
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

  const submit = async () => {
    if (!moved) return;
    const o = { x: num(at.x) ?? 0, y: num(at.y) ?? 0, z: num(at.z) ?? 0 };
    const l = limDof ? { min: limDof === "tilt" ? undefined : num(lim.min), max: num(lim.max) } : undefined;
    const limits = l && (l.min !== undefined || l.max !== undefined) ? { [limDof!]: Object.fromEntries(Object.entries(l).filter(([, x]) => x !== undefined)) } : undefined;
    const ok = await createJoint({
      kind, base, moved, baseOrigin: o, movedOrigin: o,
      ...(kind !== "rigid" ? { axis: { x: num(axis.x) ?? 0, y: num(axis.y) ?? 0, z: num(axis.z) ?? 0 } } : {}),
      ...motionParams(kind, motion), ...(limits ? { limits } : {}),
    });
    if (ok) onClose();
  };

  return (
    <div className="asm-tform" onClick={(e) => e.stopPropagation()}>
      <div className="asm-ref">
        <select className="asm-sel" aria-label="Joint kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{NEW_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
      </div>
      <div className="asm-ref">
        <span className="muted-inline" style={{ width: 38 }}>moved</span>
        <select className="asm-sel" aria-label="Moved component" value={moved} onChange={(e) => setMoved(e.target.value)}>
          {comps.filter((c) => c.id !== doc.rootComponentId).map((c) => <option key={c.id} value={c.id}>{c.name}{placed.has(c.id) ? " (jointed)" : ""}</option>)}
        </select>
      </div>
      <div className="asm-ref">
        <span className="muted-inline" style={{ width: 38 }}>base</span>
        <select className="asm-sel" aria-label="Base component" value={base} onChange={(e) => setBase(e.target.value)}>
          {comps.filter((c) => c.id !== moved).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="asm-ref" title="Where the two parts meet, drawn in place (base coordinates)">
        <span className="muted-inline" style={{ width: 38 }}>at</span>
        {(["x", "y", "z"] as const).map((k) => <input key={k} className="dim-expr" style={{ width: 38 }} aria-label={`at ${k}`} value={at[k]} onChange={(e) => setAt({ ...at, [k]: e.target.value })} />)}
      </div>
      {kind !== "rigid" && (
        <div className="asm-ref">
          <span className="muted-inline" style={{ width: 38 }}>axis</span>
          {(["x", "y", "z"] as const).map((k) => <input key={k} className="dim-expr" style={{ width: 38 }} aria-label={`axis ${k}`} value={axis[k]} onChange={(e) => setAxis({ ...axis, [k]: e.target.value })} />)}
        </div>
      )}
      <MotionFields kind={kind} v={motion} set={setMotion} />
      {limDof && (
        <div className="asm-ref" title={limDof === "tilt" ? "The cone it can lean in: its half-angle (degrees)" : "Stops: the value is held between these, and the motion study sweeps between them"}>
          <span className="muted-inline" style={{ width: 38 }}>{limDof === "tilt" ? "cone" : "stops"}</span>
          {limDof !== "tilt" && <input className="dim-expr" style={{ width: 46 }} placeholder="min" aria-label="Lower stop" value={lim.min} onChange={(e) => setLim({ ...lim, min: e.target.value })} />}
          <input className="dim-expr" style={{ width: 46 }} placeholder={limDof === "tilt" ? "half-angle" : "max"} aria-label={limDof === "tilt" ? "Cone half-angle" : "Upper stop"} value={lim.max} onChange={(e) => setLim({ ...lim, max: e.target.value })} />
        </div>
      )}
      <div className="asm-ref">
        <button className="asm-btn" disabled={!moved} onClick={() => void submit()}>add joint</button>
        <button className="asm-btn" onClick={onClose}>cancel</button>
      </div>
    </div>
  );
}

const DRIVERS: Joint["kind"][] = ["revolute", "slider", "cylindrical", "flexure", "pin-slot"];
const DRIVEN: Joint["kind"][] = ["revolute", "slider", "cylindrical"];

/** Add a coupling: one joint driven from another by a gear, belt or rack ratio. */
export function CouplingForm({ doc, onClose }: { doc: CadDocument; onClose: () => void }) {
  const createCoupling = useStore((s) => s.createCoupling);
  const joints = Object.values(doc.joints).filter((j) => !j.closes);
  const drivers = joints.filter((j) => DRIVERS.includes(j.kind));
  const driven = joints.filter((j) => DRIVEN.includes(j.kind) && !j.solve);
  const [driver, setDriver] = useState(drivers[0]?.id ?? "");
  const [target, setTarget] = useState(driven.find((j) => j.id !== drivers[0]?.id)?.id ?? "");
  const [kind, setKind] = useState<Coupling["kind"]>("gear");
  const [ratio, setRatio] = useState("1");
  const [reverse, setReverse] = useState(false);

  const submit = async () => {
    if (!driver || !target) return;
    const sign = (kind === "gear" ? -1 : 1) * (reverse ? -1 : 1);
    const ok = await createCoupling({ driver, driven: target, kind, ratio, ...(reverse ? { sign } : {}) });
    if (ok) onClose();
  };

  return (
    <div className="asm-tform" onClick={(e) => e.stopPropagation()}>
      <div className="asm-ref">
        <select className="asm-sel" aria-label="Coupling kind" value={kind} onChange={(e) => setKind(e.target.value as Coupling["kind"])}>
          <option value="gear">gear (turns the other way)</option><option value="belt">belt (the same way)</option><option value="rack">rack (turn ↔ slide)</option>
        </select>
      </div>
      <div className="asm-ref">
        <span className="muted-inline" style={{ width: 38 }}>driver</span>
        <select className="asm-sel" aria-label="Driver joint" value={driver} onChange={(e) => setDriver(e.target.value)}>{drivers.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select>
      </div>
      <div className="asm-ref">
        <span className="muted-inline" style={{ width: 38 }}>drives</span>
        <select className="asm-sel" aria-label="Driven joint" value={target} onChange={(e) => setTarget(e.target.value)}>{driven.filter((j) => j.id !== driver).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select>
      </div>
      <div className="asm-ref" title={kind === "rack" ? "Travel per turn (mm): π × module × pinion teeth" : "Driver teeth ÷ driven teeth (or pulley diameters)"}>
        <span className="muted-inline" style={{ width: 38 }}>{kind === "rack" ? "mm/turn" : "ratio"}</span>
        <input className="dim-expr" style={{ width: 70 }} aria-label="Ratio" value={ratio} onChange={(e) => setRatio(e.target.value)} />
        <label className="muted-inline"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> reverse</label>
      </div>
      <div className="asm-ref">
        <button className="asm-btn" disabled={!driver || !target} onClick={() => void submit()}>add coupling</button>
        <button className="asm-btn" onClick={onClose}>cancel</button>
      </div>
    </div>
  );
}

/** An expression input that commits on blur / Enter. */
function ExprInput({ value, width, title, label, onCommit }: { value: string; width: number; title: string; label: string; onCommit: (v: string) => void }) {
  return (
    <input className="dim-expr" style={{ width }} defaultValue={value} key={value} title={title} aria-label={label}
      onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

/** A joint's row: its kind, its motion values editable in place (or what drives them), and delete. */
export function JointRow({ doc, j }: { doc: CadDocument; j: Joint }) {
  const editJointValue = useStore((s) => s.editJointValue);
  const editJointParams = useStore((s) => s.editJointParams);
  const deleteJoint = useStore((s) => s.deleteJoint);
  const by = (dof: "value" | "slide") => Object.values(doc.couplings ?? {}).find((c) => c.driven === j.id && (c.drivenDof ?? "value") === dof);
  const coupledLabel = (c: Coupling) => <span className="muted-inline" title={`Driven by ${c.name} (${c.kind}, ×${c.sign * c.ratioValue})`}>⇐ {doc.joints[c.driver]?.name ?? c.driver}</span>;
  const lim = (dof: JointDof) => { const l = j.limits?.[dof]; return l ? ` (stops ${l.min ?? "−∞"} … ${l.max ?? "∞"})` : ""; };
  const valueField = (dof: "value" | "slide", width: number) => {
    const c = by(dof);
    if (c) return coupledLabel(c);
    const angular = dof === "value" && j.kind !== "slider";
    return dof === "value"
      ? <ExprInput value={j.valueExpr} width={width} label={`${j.name} ${angular ? "angle" : "travel"}`} title={`${angular ? "Angle (degrees)" : "Distance"}${lim("value")}`} onCommit={(v) => void editJointValue(j.id, v)} />
      : <ExprInput value={j.slideExpr ?? "0"} width={width} label={`${j.name} travel`} title={`Travel along the axis (mm)${lim("slide")}`} onCommit={(v) => void editJointParams(j.id, { slide: v })} />;
  };
  return (
    <div className="tree-row" style={{ paddingLeft: 22 }} title={j.error ? `Unresolved: ${j.error}` : `${j.kind} joint: ${doc.components[j.moved]?.name ?? j.moved} → ${doc.components[j.base]?.name ?? j.base}`}>
      <span className="tree-icon" style={{ color: "var(--ic-joint)" }}>⚙</span>
      <span className="tree-label">{j.name} <span className="muted-inline">· {j.kind}</span></span>
      {j.kind === "cylindrical" ? <>{valueField("value", 44)}{valueField("slide", 44)}</>
        : j.kind === "ball" ? (["tilt", "heading", "spin"] as const).map((k) => (
          <ExprInput key={k} value={j.ball?.[k] ?? "0"} width={36} label={`${j.name} ${k}`} title={`${FIELD_TITLE[k]}${lim(k)}`} onCommit={(v) => void editJointParams(j.id, { ball: { ...j.ball, [k]: v } })} />
        ))
        : j.kind !== "rigid" && j.kind !== "beam" && j.kind !== "planar" ? valueField("value", 54) : null}
      {j.error && <span className="dof-dot bad" />}
      <button className="asm-x" title="Delete joint (and its couplings)" onClick={(e) => { e.stopPropagation(); void deleteJoint(j.id); }}>✕</button>
    </div>
  );
}

/** A coupling's row: driver → driven, the ratio editable, the direction flippable, delete. */
export function CouplingRow({ doc, c }: { doc: CadDocument; c: Coupling }) {
  const editCoupling = useStore((s) => s.editCoupling);
  const deleteCoupling = useStore((s) => s.deleteCoupling);
  const name = (id: string) => doc.joints[id]?.name ?? id;
  return (
    <div className="tree-row" style={{ paddingLeft: 22 }} title={c.error ? `Unresolved: ${c.error}` : `${c.kind}: ${name(c.driven)} follows ${name(c.driver)}${c.kind === "rack" ? ` at ${c.ratioValue} mm a turn` : ` × ${c.ratioValue}`}, ${c.sign < 0 ? "the other way" : "the same way"}`}>
      <span className="tree-icon" style={{ color: "var(--ic-joint)" }}>⛓</span>
      <span className="tree-label">{name(c.driver)} → {name(c.driven)} <span className="muted-inline">· {c.kind}</span></span>
      <ExprInput value={c.ratioExpr} width={54} label={`${c.name} ratio`} title={c.kind === "rack" ? "Travel per turn (mm)" : "Ratio: driver teeth ÷ driven teeth"} onCommit={(v) => void editCoupling(c.id, { ratio: v })} />
      <button className="asm-btn" title={`Direction: ${c.sign < 0 ? "the other way (click for the same way)" : "the same way (click for the other way)"}`} aria-label={`${c.name} direction`} onClick={(e) => { e.stopPropagation(); void editCoupling(c.id, { sign: -c.sign }); }}>{c.sign < 0 ? "−" : "+"}</button>
      {c.error && <span className="dof-dot bad" />}
      <button className="asm-x" title="Delete coupling" onClick={(e) => { e.stopPropagation(); void deleteCoupling(c.id); }}>✕</button>
    </div>
  );
}
