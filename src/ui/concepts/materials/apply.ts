// What applying a material does, decided apart from React: which parts it
// reaches, which of them follow a parameter (so the panel asks first), which
// material is in effect where, and whether a preset is already in the
// document. Pure; tested in Node (test/materials.test.ts).

import { materialForComponent, type CadDocument, type Material } from "../../../core/document";
import type { MaterialPreset } from "./presets";

export interface ApplyPlan {
  /** Parts whose own material (or parameter choice) is removed so they take the new one from the whole model. */
  clears: string[];
  /** Parts whose material follows a parameter: applying replaces that choice, so the panel asks first. */
  choiceParts: string[];
}

/** Applying to the whole model reaches every part: each part's own material is cleared so it inherits the
 *  model's. Applying to one part replaces only its own. */
export function applyPlan(doc: CadDocument, target: string): ApplyPlan {
  const root = doc.rootComponentId;
  if (target !== root) {
    const c = doc.components[target];
    return { clears: [], choiceParts: c?.materialChoice ? [target] : [] };
  }
  const own = Object.values(doc.components).filter((c) => c.id !== root && (c.materialId || c.materialChoice));
  return { clears: own.map((c) => c.id), choiceParts: own.filter((c) => c.materialChoice).map((c) => c.id) };
}

/** The parts that carry geometry (what "N parts" counts). */
export function parts(doc: CadDocument): string[] {
  return Object.values(doc.components).filter((c) => c.sketches.length > 0).map((c) => c.id);
}

/** How many parts a material is actually in effect on (own, inherited or picked by a parameter). */
export function partsUsing(doc: CadDocument, materialId: string): number {
  return parts(doc).filter((id) => materialForComponent(doc, id)?.id === materialId).length;
}

/** The material in effect on a component: its own, a parameter's pick, or its nearest ancestor's. */
export function effectiveMaterial(doc: CadDocument, componentId: string): Material | undefined {
  return materialForComponent(doc, componentId);
}

/** "Follows “material”: PLA · PETG · TPU" for a part whose material a parameter picks; null otherwise. */
export function choiceText(doc: CadDocument, componentId: string): string | null {
  const ch = doc.components[componentId]?.materialChoice;
  if (!ch) return null;
  return `Follows the parameter “${ch.by}”: ${ch.materials.map((id) => doc.materials[id]?.name ?? id).join(" · ")}`;
}

/** A material already in the document made from this preset (same name and kind): applying the preset reuses it. */
export function presetInDoc(doc: CadDocument, preset: MaterialPreset): Material | undefined {
  return Object.values(doc.materials).find((m) => m.name === preset.name && m.kind === preset.params.kind);
}

/** "A", "A and B", "A, B and 2 more". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
