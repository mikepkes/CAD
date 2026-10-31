// The Workbench's arithmetic and decisions, kept apart from React: where a pin
// sits, how a cluster reads, which feature a face belongs to, what the history
// strip shows for a rollback position. Tested in Node (test/workbench.test.ts);
// the .tsx files only template this. The edit throttle is the kit's editQueue.

import type { FeatureRow } from "../../../model/concepts/featureCatalog";
import { pinAnchor, unionBounds, boundsCentre, unitLabel, paramsWith } from "../../../model/concepts/featureCatalog";
import { pinOffset, clampInside, CARD_W_NARROW, type Pt, type Box } from "../../kit/anchor";
import { quantize, formatMagnitude, type NumberSpec } from "../../kit/numberMath";
import type { SolidEval } from "../../../core/features";
import type { SolidMesh, Bounds3 } from "../../../core/occ/kernel";
import type { CadDocument } from "../../../core/document";
import type { OperationRecord } from "../../../core/command/types";

export { unionBounds, unitLabel, paramsWith };

export type Vec3 = { x: number; y: number; z: number };
export type PinDir = "ne" | "nw" | "se" | "sw";

/** Pin radius in px (the kit's .k-pin is 28 px wide). */
export const PIN_R = 14;
/** Pins closer than this merge into a cluster badge. */
export const CLUSTER_RADIUS = 26;

// ---- pins ----

/** The direction a pin is pushed from its anchor: away from the viewport centre, so it sits beside the geometry, which is usually framed around the centre. */
export function quadrantDir(p: Pt, bounds: Box): PinDir {
  const ns = p.y < bounds.h / 2 ? "n" : "s";
  const ew = p.x < bounds.w / 2 ? "w" : "e";
  return `${ns}${ew}` as PinDir;
}

export interface PinPlacement { row: FeatureRow; anchor: Pt; pos: Pt }

/** The rows of the active component that have an anchor, paired with it (what gets a pin of its own). */
export function visiblePins(rows: FeatureRow[], anchors: (Vec3 | null)[], activeComponentId: string): { row: FeatureRow; anchor: Vec3 }[] {
  const out: { row: FeatureRow; anchor: Vec3 }[] = [];
  rows.forEach((row, i) => { const anchor = anchors[i]; if (anchor && row.componentId === activeComponentId) out.push({ row, anchor }); });
  return out;
}

/** A cluster's identity across renders: its members' feature ids. */
export function clusterKey(members: { row: FeatureRow }[]): string {
  return members.map((m) => m.row.featureId).join(",");
}

/** Whether one of the members is the given feature (the open or the hot one). */
export function hasMember(members: { row: FeatureRow }[], featureId: string | null): boolean {
  return featureId != null && members.some((m) => m.row.featureId === featureId);
}

/** The size a cluster's chooser is assumed to have until measured: one row of 30 px per member. */
export function chooserSize(members: number): Box {
  return { w: CARD_W_NARROW, h: 40 + 30 * members };
}

/** Where each row's pin anchors in world space. A modifier (fillet, shell…) whose row carries no body of its own
 *  borrows the body of the nearest earlier row in the same component, so it still gets a pin on the part it changed. */
export function pinAnchors(rows: FeatureRow[]): (Vec3 | null)[] {
  return rows.map((row, i) => {
    const own = pinAnchor(row);
    if (own) return own;
    for (let j = i - 1; j >= 0; j--) {
      const prev = rows[j];
      if (prev.componentId === row.componentId && prev.solid?.bounds) return pinAnchor({ ...row, solid: prev.solid });
    }
    return null;
  });
}

/** Pin positions for the visible anchors: offset by quadrant, kept inside the viewport. */
export function placePins(items: { row: FeatureRow; proj: Pt & { visible: boolean } }[], bounds: Box): PinPlacement[] {
  const out: PinPlacement[] = [];
  for (const { row, proj } of items) {
    if (!proj.visible) continue;
    const anchor = { x: proj.x, y: proj.y };
    const raw = pinOffset(anchor, quadrantDir(anchor, bounds));
    const tl = clampInside({ x: raw.x - PIN_R, y: raw.y - PIN_R }, { w: 2 * PIN_R, h: 2 * PIN_R }, bounds, 4);
    out.push({ row, anchor, pos: { x: tl.x + PIN_R, y: tl.y + PIN_R } });
  }
  return out;
}

export type PinState = "open" | "err" | "off" | "ghost" | "";

/** The pin's state class: open wins (it is the one being edited), then error, suppressed, rolled back. */
export function pinState(row: FeatureRow, openFeature: string | null): PinState {
  if (row.featureId === openFeature) return "open";
  if (row.error) return "err";
  if (row.suppressed) return "off";
  if (row.rolledBack) return "ghost";
  return "";
}

/** The leader line's class: the same as the pin's, but only the states the kit draws. */
export function leaderState(row: FeatureRow, openFeature: string | null): "open" | "ghost" | "" {
  const s = pinState(row, openFeature);
  return s === "open" || s === "ghost" ? s : "";
}

/** "3 · 4 · 5" for a few, "3–9" for a consecutive run of more than three. */
export function clusterLabel(nums: number[]): string {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return "";
  const consecutive = s.every((n, i) => i === 0 || n === s[i - 1] + 1);
  if (consecutive && s.length > 3) return `${s[0]}–${s[s.length - 1]}`;
  return s.join(" · ");
}

/** The badge text for a collapsed component ("Outer ring · 7"). */
export function componentLabel(name: string, count: number): string {
  return `${name} · ${count}`;
}

export interface ComponentGroup { componentId: string; rows: FeatureRow[]; centre: Vec3 | null }

/** Rows of every component but the active one, each with the world centre of its bodies' bounds (null when nothing is built). */
export function otherComponentGroups(rows: FeatureRow[], activeComponentId: string): ComponentGroup[] {
  const by = new Map<string, FeatureRow[]>();
  for (const r of rows) {
    if (r.componentId === activeComponentId) continue;
    const list = by.get(r.componentId) ?? [];
    list.push(r);
    by.set(r.componentId, list);
  }
  return [...by.entries()].map(([componentId, list]) => ({ componentId, rows: list, centre: centreOf(list) }));
}

/** Centre of the union of the rows' body bounds, else the mean of their pin anchors. */
export function centreOf(rows: FeatureRow[]): Vec3 | null {
  const bounds = rows.map((r) => r.solid?.bounds).filter((b): b is Bounds3 => !!b);
  const u = unionBounds(bounds);
  if (u) return boundsCentre(u);
  const pts = rows.map(pinAnchor).filter((p): p is Vec3 => !!p);
  if (!pts.length) return null;
  const n = pts.length;
  return { x: pts.reduce((a, p) => a + p.x, 0) / n, y: pts.reduce((a, p) => a + p.y, 0) / n, z: pts.reduce((a, p) => a + p.z, 0) / n };
}

// ---- faces ----

/** The feature a face name belongs to: the prefix before ':' ("extrude3:end" → "extrude3"), else the body itself. */
export function featureIdOfFace(faceName: string | undefined, bodyId: string): string {
  if (faceName) {
    const i = faceName.indexOf(":");
    if (i > 0) return faceName.slice(0, i);
  }
  return bodyId;
}

/** The row a clicked face maps to: its naming feature, else the body's row. */
export function rowForFace(rows: FeatureRow[], faceName: string | undefined, bodyId: string): FeatureRow | undefined {
  const id = featureIdOfFace(faceName, bodyId);
  return rows.find((r) => r.featureId === id) ?? rows.find((r) => r.featureId === bodyId) ?? rows.find((r) => r.solid?.featureId === bodyId);
}

/** Area of one named face summed over its display triangles (an estimate of the exact B-rep area; null when the mesh has no such face). */
export function faceAreaFromMesh(mesh: SolidMesh | undefined, faceName: string | undefined): number | null {
  if (!mesh || !faceName || !mesh.faceRanges || !mesh.faceNames) return null;
  const k = mesh.faceNames.indexOf(faceName);
  if (k < 0) return null;
  const start = mesh.faceRanges[2 * k], count = mesh.faceRanges[2 * k + 1];
  if (start == null || count == null) return null;
  const P = mesh.positions, I = mesh.indices;
  let area = 0;
  for (let i = start; i + 2 < start + count && i + 2 < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += 0.5 * Math.hypot(cx, cy, cz);
  }
  return area;
}

export interface Measurement { label: string; value: string; title?: string }

/** What "Measure" shows for a face on a body: the face area (mesh estimate), the body's exact volume, area and bounds from the kernel. */
export function measurements(solid: SolidEval | undefined, faceName: string | undefined): Measurement[] {
  const out: Measurement[] = [];
  const fa = faceAreaFromMesh(solid?.mesh, faceName);
  if (fa != null) out.push({ label: "Face area ≈", value: formatArea(fa), title: "Estimated from the display mesh, not the exact B-rep surface" });
  if (!solid) return out;
  if (solid.volume != null) out.push({ label: "Volume", value: formatVolume(solid.volume) });
  if (solid.area != null) out.push({ label: "Surface", value: formatArea(solid.area) });
  if (solid.bounds) out.push({ label: "Bounds", value: formatBounds(solid.bounds) });
  return out;
}

/** Areas read in cm² from 100 cm² up, volumes in cm³ from 1 cm³ up; precision follows the kit's magnitude rule. */
export function formatArea(mm2: number): string { return mm2 >= 1e4 ? formatMagnitude(mm2 / 100, "cm²") : formatMagnitude(mm2, "mm²"); }
export function formatVolume(mm3: number): string { return mm3 >= 1e3 ? formatMagnitude(mm3 / 1000, "cm³") : formatMagnitude(mm3, "mm³"); }
export function formatBounds(b: Bounds3): string {
  const d = (v: number) => formatMagnitude(v, "", { digits: 1 });
  return `${d(b.max.x - b.min.x)} × ${d(b.max.y - b.min.y)} × ${d(b.max.z - b.min.z)} mm`;
}

/** The question before a delete, and the decision: delete only when the asker agrees. */
export function deletePrompt(row: Pick<FeatureRow, "name">): string {
  return `Delete ${row.name}? Features that depend on it may fail.`;
}
export function shouldDelete(row: Pick<FeatureRow, "name">, ask: ((text: string) => boolean) | undefined): boolean {
  return ask ? ask(deletePrompt(row)) : true;
}

// ---- parameters ----

export interface CardParam { key: string; label: string; unit: string; spec: NumberSpec; value: number; expr: string; numeric: boolean }

/** The editable numbers a card shows for a row: the spec's params the op actually carries, with their live value. */
export function cardParams(row: FeatureRow): CardParam[] {
  return row.spec.params.filter((p) => row.exprs[p.key] != null).map((p) => {
    const value = row.values[p.key];
    return { key: p.key, label: p.label, unit: unitLabel(p.unit), spec: { min: p.min, max: p.max, step: p.step }, value, expr: row.exprs[p.key], numeric: Number.isFinite(value) };
  });
}

/** The value after one Push/Pull step in `dir` (−1 or +1), within the param's bounds. */
export function pushed(value: number, dir: -1 | 1, spec: NumberSpec): number {
  return quantize(value + dir * spec.step, spec);
}

/** The Push/Pull param of the row a face belongs to, when its spec has one. */
export function pushParamOf(row: FeatureRow | undefined): CardParam | null {
  if (!row?.spec.pushParam) return null;
  return cardParams(row).find((p) => p.key === row.spec.pushParam) ?? null;
}

/** Height a feature card is assumed to have until it is measured (useCardSize): head, one row per param, foot. */
export function cardHeight(nParams: number): number { return 58 + 34 * nParams + 52; }

// ---- components: the crumb and the strip's scope ----

export interface Crumb { id: string; name: string }

/** Whether `id` is `ancestorId` or sits below it in the component tree (an unknown id is nobody's descendant). */
export function isDescendant(doc: CadDocument, id: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null | undefined = id; cur && !seen.has(cur); cur = doc.components[cur]?.parentId) {
    if (!doc.components[cur]) return false;
    if (cur === ancestorId) return true;
    seen.add(cur);
  }
  return false;
}

/** The path from the root component to the active one, root first. An unknown or detached active id gives the root alone.
 *  The root crumb reads the root component's name (the document's name), falling back to the document id. */
export function crumbPath(doc: CadDocument, activeId: string): Crumb[] {
  const root = doc.components[doc.rootComponentId];
  const rootCrumb: Crumb = { id: doc.rootComponentId, name: root?.name || doc.id };
  const path: Crumb[] = [];
  const seen = new Set<string>();
  for (let cur: string | null | undefined = activeId; cur && !seen.has(cur) && cur !== doc.rootComponentId; cur = doc.components[cur]?.parentId) {
    const c = doc.components[cur];
    if (!c) return [rootCrumb];
    seen.add(cur);
    path.unshift({ id: c.id, name: c.name });
    if (c.parentId == null) return [rootCrumb]; // a detached tree: not under the root
  }
  return [rootCrumb, ...path];
}

/** The crumb earns its space once the document has more than one component. */
export function showCrumb(doc: CadDocument): boolean {
  return Object.keys(doc.components).length > 1;
}

export interface ScopedRows { rows: FeatureRow[]; hidden: number }

/** The rows in the active component's scope (its own and its descendants'), and how many the scope hides.
 *  With the root active every row is in scope. */
export function rowsInScope(rows: FeatureRow[], doc: CadDocument, activeId: string): ScopedRows {
  const out: FeatureRow[] = [];
  let hidden = 0;
  for (const r of rows) {
    if (activeId === doc.rootComponentId || isDescendant(doc, r.componentId, activeId)) out.push(r);
    else hidden++;
  }
  return { rows: out, hidden };
}

/** "3 more in other components" — the chip at the end of a scoped strip. */
export function moreLabel(hidden: number): string {
  return `${hidden} more in other component${hidden === 1 ? "" : "s"}`;
}

/** An assembly-level step: a joint, a component or a component pattern, which belongs to no one component.
 *  Features, sketch ops and parameter ops are not steps (the catalog's rows carry the features). */
export function isAssemblyStep(op: Pick<OperationRecord, "type">): boolean {
  return op.type.startsWith("joint.") || op.type.startsWith("component.") || op.type.startsWith("assembly.");
}

/** What a step chip reads: a new component by its name (the document's while it exists, else the name the op asked for,
 *  so a rolled-back step keeps its name), anything else by the op's own label. */
export function stepLabel(op: OperationRecord, doc: CadDocument): string {
  if (op.type === "component.create") {
    const c = doc.components[op.createdIds[0] ?? ""];
    if (c) return c.name;
    const asked = (op.params as { name?: unknown }).name;
    if (typeof asked === "string" && asked) return asked;
  }
  return op.label || op.type;
}

/** One stop on the strip: a feature row, or an assembly step. A FeatureRow is itself a StripEntry. */
export interface StripEntry {
  /** The pin / chip number of a feature; a step has none. */
  num?: number;
  name: string;
  /** Global timeline index of the op. */
  index: number;
  opId: string;
  /** A feature's id; a step has none. */
  featureId?: string;
  suppressed: boolean;
  rolledBack: boolean;
  error?: string;
  /** The assembly op, for steps. */
  step?: OperationRecord;
}

/** The assembly steps of the timeline as strip entries (shown only while the root is active). */
export function assemblySteps(timeline: OperationRecord[], rollbackIndex: number, doc: CadDocument): StripEntry[] {
  const out: StripEntry[] = [];
  timeline.forEach((op, index) => {
    if (!isAssemblyStep(op)) return;
    out.push({ name: stepLabel(op, doc), index, opId: op.opId, suppressed: !!op.suppressed, rolledBack: index >= rollbackIndex, error: op.error, step: op });
  });
  return out;
}

/** The strip's entries for an active component: its rows in scope and, at the root, the assembly steps, in timeline order. */
export function stripEntries(rows: FeatureRow[], doc: CadDocument, activeId: string, timeline: OperationRecord[], rollbackIndex: number): StripEntry[] {
  const scoped: StripEntry[] = rowsInScope(rows, doc, activeId).rows;
  const steps = activeId === doc.rootComponentId ? assemblySteps(timeline, rollbackIndex, doc) : [];
  return [...scoped, ...steps].sort((a, b) => a.index - b.index);
}

// ---- history strip ----

export interface StripChip<T extends StripEntry = FeatureRow> { row: T; state: "at" | "ghost" | undefined; off: boolean; err: boolean }
export interface StripState<T extends StripEntry = FeatureRow> {
  chips: StripChip<T>[];
  /** Entries built (before the marker). */
  built: number;
  /** Something after the marker is rolled back. */
  rolledBack: boolean;
  text: string;
  atRow: T | null;
}

/** "3 features", "2 assembly steps", "3 features and 2 assembly steps". */
export function countText(entries: StripEntry[]): string {
  const features = entries.filter((e) => e.num != null).length;
  const steps = entries.length - features;
  const parts: string[] = [];
  if (features) parts.push(`${features} feature${features === 1 ? "" : "s"}`);
  if (steps) parts.push(`${steps} assembly step${steps === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

export function stripState<T extends StripEntry>(rows: T[], rollbackIndex: number, timelineLength: number): StripState<T> {
  let atRow: T | null = null;
  for (const r of rows) if (r.index < rollbackIndex) atRow = r;
  const rolledBack = rollbackIndex < timelineLength;
  const chips: StripChip<T>[] = rows.map((row) => ({
    row,
    state: row.rolledBack ? "ghost" : row === atRow ? "at" : undefined,
    off: row.suppressed,
    err: !!row.error,
  }));
  const built = rows.filter((r) => !r.rolledBack).length;
  const at = (r: T) => (r.num != null ? `${r.num} · ${r.name}` : r.name);
  const text = !rows.length
    ? "No features yet"
    : rolledBack
      ? atRow ? `At ${at(atRow)} — new features insert here` : "At the start — new features insert here"
      : `All ${countText(rows)} built`;
  return { chips, built, rolledBack, text, atRow };
}

/** The timeline index to roll to so that the first `k` feature rows are built (k = rows.length rolls to the end). */
export function rollbackIndexForStep(rows: FeatureRow[], k: number, timelineLength: number): number {
  if (!rows.length || k >= rows.length) return timelineLength;
  if (k <= 0) return rows[0].index;
  return rows[k - 1].index + 1;
}

export interface StripRange { min: number; max: number; stops: number[] }

/** The range input over the visible entries, in global timeline indices: `min` builds none of them, `max` all of them,
 *  and `stops` are `min` and the index just after each entry (where the marker sits meaningfully). No entries give 0..0. */
export function stripRange(visible: StripEntry[]): StripRange {
  if (!visible.length) return { min: 0, max: 0, stops: [] };
  const sorted = [...visible].sort((a, b) => a.index - b.index);
  const min = sorted[0].index;
  const stops = [min, ...sorted.map((e) => e.index + 1)];
  return { min, max: stops[stops.length - 1], stops };
}

/** The range's value for a rollback index: clamped to the visible range. */
export function rangeValue(range: StripRange, rollbackIndex: number): number {
  return Math.min(range.max, Math.max(range.min, rollbackIndex));
}

/** The rollback index a dragged range value means: the nearest stop (ties go to the later one), so the marker
 *  never lands between two visible entries, on an op the strip does not show. */
export function snapRollback(range: StripRange, value: number): number {
  if (!range.stops.length) return value;
  let best = range.stops[0];
  for (const s of range.stops) if (Math.abs(s - value) <= Math.abs(best - value)) best = s;
  return best;
}
