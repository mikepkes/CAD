// The Materials tab: the document's material library, each drawn as a rendered
// swatch; apply one to a part, edit any of its properties, or add one from the
// presets (real finishes, with mechanical properties for prints and rubber).
// Every change is a material.create / material.update / material.assign
// command, so it undoes, rebuilds and travels with the file like the rest.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../../model/store";
import type { CadDocument, Material } from "../../../core/document";
import { MATERIAL_KINDS, SURFACE_TEXTURES } from "../../../core/document";
import { materialSpec } from "../../../viewport/material";
import { materialSwatch } from "../../../viewport/swatch";
import { SPECIES_KEYS } from "../../../viewport/material";
import { Button, Pills, Select } from "../../kit/primitives";
import { MATERIAL_PRESETS, MaterialPreset } from "./presets";
import "./materials.css";

const FINISHES: Record<string, string[]> = {
  metal: ["polished", "satin", "brushed", "matte"],
  plastic: ["gloss", "satin", "matte"],
  printed: ["silk", "satin", "matte"],
  painted: ["gloss", "matte"],
};
const AXES = [{ key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "z", label: "Z" }] as const;
type AxisKey = (typeof AXES)[number]["key"];

/** A rendered ball of the material, or a flat chip of its colour where there's no WebGL. */
export function Swatch(p: { spec: Parameters<typeof materialSwatch>[0]; px?: number }) {
  const px = p.px ?? 40;
  const url = useMemo(() => materialSwatch(p.spec, px), [JSON.stringify(p.spec), px]); // eslint-disable-line react-hooks/exhaustive-deps
  return url
    ? <img className="mat-swatch" src={url} width={px} height={px} alt="" />
    : <span className="mat-swatch flat" style={{ width: px, height: px, background: p.spec.color ?? "#888" }} />;
}

const usedBy = (doc: CadDocument, id: string) => Object.values(doc.components).filter((c) => c.materialId === id).length;
const kindLine = (m: Material) => [m.kind, m.kind === "wood" ? m.species : m.finish, m.texture && m.texture !== "none" ? m.texture : null, m.kind === "printed" ? `${m.layerHeight ?? 0.2} mm layers along ${(m.printAxis ?? "z").toUpperCase()}` : null, m.kind === "paper" && m.backColor && m.backColor !== m.color ? "two-sided" : null].filter(Boolean).join(" · ");

export function MaterialsPanel() {
  useStore((s) => s.rev);
  const doc = useStore((s) => s.session.doc);
  const active = useStore((s) => s.activeComponentId);
  const [target, setTarget] = useState<string>(active);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setTarget(active), [active]);
  const dispatch = useStore.getState().dispatch;
  const comp = doc.components[target] ?? doc.components[doc.rootComponentId];
  const components = Object.values(doc.components);
  const mats = Object.values(doc.materials);

  const apply = (id: string) => dispatch("material.assign", { material: id, ...(comp.id === doc.rootComponentId ? {} : { component: comp.id }) });
  const add = async (p: MaterialPreset) => {
    const r = await dispatch("material.create", { name: p.name, ...p.params });
    if (r.ok) await apply(r.createdIds[0]);
  };

  return (
    <section className="panel mats" aria-label="Materials">
      <div className="mats-head">
        <span className="k-label">Apply to</span>
        <Select ariaLabel="Apply materials to" value={comp.id}
          options={components.map((c) => ({ key: c.id, label: c.id === doc.rootComponentId ? "Whole model" : c.name }))}
          onChange={setTarget} />
      </div>

      {mats.length > 0 && (
        <ul className="mats-list" aria-label="Document materials">
          {mats.map((m) => {
            const on = comp.materialId === m.id;
            return (
              <li key={m.id} className={`mats-row${on ? " on" : ""}`}>
                <button className="mats-pick" onClick={() => void apply(m.id)} title={`Apply ${m.name} to ${comp.id === doc.rootComponentId ? "the whole model" : comp.name}`}>
                  <Swatch spec={materialSpec(m)} />
                  <span className="mats-name">
                    <b>{m.name}</b>
                    <span className="k-dim">{kindLine(m)}{usedBy(doc, m.id) ? ` · ${usedBy(doc, m.id)} part${usedBy(doc, m.id) > 1 ? "s" : ""}` : ""}</span>
                  </span>
                </button>
                <Button size="sm" ghost on={editing === m.id} ariaLabel={`Edit ${m.name}`} onClick={() => setEditing(editing === m.id ? null : m.id)}>Edit</Button>
                {editing === m.id && <MaterialEditor m={m} />}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mats-presets" aria-label="Add a material">
        {(["Metal", "Plastic", "3D print", "Rubber", "Paint", "Wood", "Paper"] as const).map((g) => (
          <div key={g} className="mats-group">
            <span className="k-label">{g}</span>
            <div className="mats-grid">
              {MATERIAL_PRESETS.filter((p) => p.group === g).map((p) => (
                <button key={p.name} className="mats-preset" title={`Add ${p.name} and apply it`} onClick={() => void add(p)}>
                  <Swatch spec={materialSpec(p.params as unknown as Parameters<typeof materialSpec>[0])} px={44} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Every property of one material; each edit is a material.update (colour and sliders settle before they commit). */
function MaterialEditor({ m }: { m: Material }) {
  const dispatch = useStore.getState().dispatch;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const set = (fields: Record<string, unknown>, delay = 0) => {
    if (timer.current) clearTimeout(timer.current);
    const go = () => void dispatch("material.update", { material: m.id, ...fields });
    if (delay) timer.current = setTimeout(go, delay); else go();
  };
  const finishes = FINISHES[m.kind];
  return (
    <div className="mats-edit" aria-label={`${m.name} properties`}>
      <label><span>Name</span><input className="k-input" aria-label="Material name" defaultValue={m.name} onBlur={(e) => e.target.value.trim() && e.target.value !== m.name && set({ name: e.target.value.trim() })} /></label>
      <label><span>Kind</span><Select ariaLabel="Kind" value={m.kind} options={MATERIAL_KINDS.map((k) => ({ key: k, label: k }))} onChange={(k) => set({ kind: k })} /></label>
      {m.kind === "wood"
        ? <label><span>Species</span><Select ariaLabel="Species" value={m.species ?? "white-oak"} options={SPECIES_KEYS.map((k) => ({ key: k, label: k }))} onChange={(k) => set({ species: k })} /></label>
        : <label><span>Colour</span><input type="color" aria-label="Colour" defaultValue={m.color ?? "#888888"} onChange={(e) => set({ color: e.target.value }, 250)} /></label>}
      {m.kind === "paper" && (
        <label title="The other side of the sheet (origami paper is coloured on one side)"><span>Back colour</span><input type="color" aria-label="Back colour" defaultValue={m.backColor ?? m.color ?? "#f3f1ec"} onChange={(e) => set({ backColor: e.target.value }, 250)} /></label>
      )}
      {finishes && <label><span>Finish</span><Select ariaLabel="Finish" value={m.finish ?? finishes[1] ?? finishes[0]} options={finishes.map((f) => ({ key: f, label: f }))} onChange={(f) => set({ finish: f })} /></label>}
      {m.kind !== "wood" && (
        <label><span>Roughness</span><input type="range" aria-label="Roughness" min={0} max={1} step={0.01} defaultValue={m.roughness ?? 0.4} onChange={(e) => set({ roughness: Number(e.target.value) }, 200)} /></label>
      )}
      {m.kind !== "wood" && m.kind !== "paper" && (
        <label><span>Texture</span><Select ariaLabel="Texture" value={m.texture ?? (m.kind === "rubber" ? "stipple" : "none")} options={SURFACE_TEXTURES.map((t) => ({ key: t, label: t }))} onChange={(t) => set({ texture: t })} /></label>
      )}
      {m.texture && m.texture !== "none" && (
        <label><span>Pitch (mm)</span><input type="number" className="k-input" aria-label="Texture pitch" min={0.1} step={0.1} defaultValue={m.textureScale ?? 1.5} onChange={(e) => Number(e.target.value) > 0 && set({ textureScale: Number(e.target.value) }, 300)} /></label>
      )}
      {(m.texture === "dimples" || m.texture === "knurl" || m.texture === "hex") && (
        <label title="Wrap the pattern round the part's long axis, sized along its surface (grips, knobs, collars), instead of projecting it"><span>Wrap round part</span><input type="checkbox" aria-label="Wrap round part" defaultChecked={!!m.textureWrap} onChange={(e) => set({ textureWrap: e.target.checked })} /></label>
      )}
      {(m.texture === "ribs" || m.finish === "brushed") && (
        <label><span>{m.finish === "brushed" ? "Brushed along" : "Ribs across"}</span><Pills ariaLabel="Texture axis" value={(m.textureAxis ?? "z") as AxisKey} options={[...AXES]} onChange={(a) => set({ textureAxis: a })} /></label>
      )}
      {m.kind === "printed" && (
        <>
          <label><span>Layer height (mm)</span><input type="number" className="k-input" aria-label="Layer height" min={0.04} max={1} step={0.02} defaultValue={m.layerHeight ?? 0.2} onChange={(e) => Number(e.target.value) > 0 && set({ layerHeight: Number(e.target.value) }, 300)} /></label>
          <label title="The build direction: the layers stack along it, and the part is weakest pulled along it"><span>Printed along</span><Pills ariaLabel="Print direction" value={(m.printAxis ?? "z") as AxisKey} options={[...AXES]} onChange={(a) => set({ printAxis: a })} /></label>
        </>
      )}
      <div className="mats-mech">
        <span className="k-label">Strength</span>
        <label><span>E (MPa)</span><input type="number" className="k-input" aria-label="Young's modulus" min={0} defaultValue={m.mechanical?.E ?? ""} placeholder="—" onChange={(e) => Number(e.target.value) > 0 && set({ youngsModulus: Number(e.target.value), allowableStrain: m.mechanical?.allowableStrain ?? 0.02 }, 400)} /></label>
        <label><span>Allowable strain</span><input type="number" className="k-input" aria-label="Allowable strain" min={0} step={0.005} defaultValue={m.mechanical?.allowableStrain ?? ""} placeholder="—" onChange={(e) => Number(e.target.value) > 0 && set({ allowableStrain: Number(e.target.value), youngsModulus: m.mechanical?.E ?? 2000 }, 400)} /></label>
        {m.kind === "printed" && (
          <label title="The share of the allowable strain left when the part is pulled across its layers"><span>Across layers</span><input type="number" className="k-input" aria-label="Strength across layers" min={0.05} max={1} step={0.05} defaultValue={m.mechanical?.layerFactor ?? 0.5} onChange={(e) => Number(e.target.value) > 0 && set({ layerFactor: Math.min(1, Number(e.target.value)), youngsModulus: m.mechanical?.E ?? 3500, allowableStrain: m.mechanical?.allowableStrain ?? 0.02 }, 400)} /></label>
        )}
      </div>
    </div>
  );
}
