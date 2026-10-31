// One description of every feature kind — its label, its editable numbers and
// the sentence that reads it back — that pins, feature cards, the Ledger, the
// history strip and the intent line all template from. Add a kind here once
// and every surface learns it; nothing else may hard-code a feature's fields.

import type { CadDocument, FeatureDef } from "../../core/document";
import type { OperationRecord } from "../../core/command/types";
import type { SolidEval } from "../../core/features";
import { resolveParameters } from "../../core/parameters";
import { compileExpr } from "../../math/expr";
import type { NumberSpec } from "../../ui/kit/numberMath";

export type Unit = "mm" | "deg" | "";

export interface ParamSpec extends NumberSpec {
  /** Key in the operation's params (what editOperation receives). */
  key: string;
  /** Human label ("Distance"). */
  label: string;
  unit: Unit;
  /** A count (integer, no unit) rather than a length. */
  count?: boolean;
}

/** A piece of a feature's sentence: literal text, or a live parameter. */
export type Segment = { text: string } | { param: string } | { ref: string; text: string };

export interface FeatureSpec {
  kind: FeatureDef["kind"];
  /** The command that creates it. */
  op: string;
  label: string;
  /** Editable numbers, in sentence order. */
  params: ParamSpec[];
  /** The sentence read back in the Ledger. `names` resolves ids to display names. */
  sentence: (op: OperationRecord, names: (id: string) => string) => Segment[];
  /** The op param a Push/Pull on this feature's face drives (if any). */
  pushParam?: string;
}

const mm = (key: string, label: string, min: number, max: number, step = 0.5): ParamSpec => ({ key, label, unit: "mm", min, max, step });
const deg = (key: string, label: string): ParamSpec => ({ key, label, unit: "deg", min: -360, max: 360, step: 1 });
const count = (key: string, label: string, max = 50): ParamSpec => ({ key, label, unit: "", min: 1, max, step: 1, count: true });
const T = (text: string): Segment => ({ text });
const P = (param: string): Segment => ({ param });
const opVerb = (o: unknown) => (o === "cut" ? " cut from the body" : o === "join" ? " joined to the body" : o === "intersect" ? " kept where it meets the body" : "");

const SPECS: FeatureSpec[] = [
  { kind: "extrude", op: "feature.extrude", label: "Extrude", params: [mm("distance", "Distance", 0.5, 500)], pushParam: "distance",
    sentence: (op, names) => [T("Extrude "), { ref: String(op.params.sketch), text: names(String(op.params.sketch)) }, T(" by "), P("distance"), T(op.params.symmetric ? " each way" : ""), T(opVerb(op.params.operation)), T(".")] },
  { kind: "revolve", op: "feature.revolve", label: "Revolve", params: [deg("angle", "Angle")],
    sentence: (op, names) => [T("Revolve "), { ref: String(op.params.sketch), text: names(String(op.params.sketch)) }, T(" through "), P("angle"), T(opVerb(op.params.operation)), T(".")] },
  { kind: "primitive", op: "feature.primitive", label: "Primitive", params: [mm("x", "X", 0.5, 500), mm("y", "Y", 0.5, 500), mm("z", "Z", 0.5, 500), mm("radius", "Radius", 0.5, 250), mm("height", "Height", 0.5, 500)],
    sentence: (op) => {
      const shape = String(op.params.shape ?? "box");
      const segs: Segment[] = [T(`Add a ${shape}`)];
      if (op.params.x != null) segs.push(T(" "), P("x"), T(" × "), P("y"), T(" × "), P("z"));
      else if (op.params.radius != null) segs.push(T(" of radius "), P("radius"), ...(op.params.height != null ? [T(", "), P("height"), T(" tall")] : []));
      segs.push(T(opVerb(op.params.operation)), T("."));
      return segs;
    } },
  { kind: "hole", op: "feature.hole", label: "Hole", params: [mm("diameter", "Diameter", 0.5, 100), mm("depth", "Depth", 0.5, 500)], pushParam: "diameter",
    sentence: (op) => {
      const n = Array.isArray(op.params.at) ? op.params.at.length : 1;
      return [T(n > 1 ? `Drill ${n} holes ⌀` : "Drill a hole ⌀"), P("diameter"), ...(op.params.throughAll ? [T(" through")] : op.params.depth != null ? [T(", "), P("depth"), T(" deep")] : []), T(".")];
    } },
  { kind: "fillet", op: "feature.fillet", label: "Fillet", params: [mm("radius", "Radius", 0.1, 50, 0.1)], pushParam: "radius",
    sentence: () => [T("Round the edges to "), P("radius"), T(".")] },
  { kind: "chamfer", op: "feature.chamfer", label: "Chamfer", params: [mm("distance", "Distance", 0.1, 50, 0.1)], pushParam: "distance",
    sentence: () => [T("Chamfer the edges by "), P("distance"), T(".")] },
  { kind: "shell", op: "feature.shell", label: "Shell", params: [mm("thickness", "Wall", 0.2, 50, 0.1)], pushParam: "thickness",
    sentence: () => [T("Hollow it to a "), P("thickness"), T(" wall.")] },
  { kind: "pattern", op: "feature.pattern", label: "Pattern", params: [count("count", "Count")],
    sentence: (op) => [T(`Repeat it ${op.params.mode === "circular" ? "around" : "along a line"}, `), P("count"), T(" times.")] },
  { kind: "mirror", op: "feature.mirror", label: "Mirror", params: [],
    sentence: (op) => [T(`Mirror it across the ${String(op.params.plane)} plane.`)] },
  { kind: "sheet", op: "feature.sheet", label: "Sheet", params: [mm("thickness", "Thickness", 0.1, 25, 0.1), mm("radius", "Bend radius", 0, 25, 0.1)], pushParam: "thickness",
    sentence: (op, names) => [T("Make a sheet from "), { ref: String(op.params.sketch), text: names(String(op.params.sketch)) }, T(", "), P("thickness"), T(" thick.")] },
  { kind: "flange", op: "feature.flange", label: "Flange", params: [mm("length", "Length", 0.5, 500), deg("angle", "Angle"), mm("radius", "Bend radius", 0, 25, 0.1)], pushParam: "length",
    sentence: (op) => [T(`Add a flange on ${String(op.params.edge)}, `), P("length"), T(" long"), ...(op.params.angle != null ? [T(" at "), P("angle")] : []), T(".")] },
  { kind: "fold", op: "feature.fold", label: "Fold", params: [deg("angle", "Angle"), mm("radius", "Bend radius", 0, 25, 0.1)],
    sentence: () => [T("Fold along the line by "), P("angle"), T(".")] },
  { kind: "unfold", op: "feature.unfold", label: "Unfold", params: [], sentence: () => [T("Unfold it flat.")] },
  { kind: "refold", op: "feature.refold", label: "Refold", params: [], sentence: () => [T("Fold it back up.")] },
  { kind: "member", op: "feature.member", label: "Member", params: [],
    sentence: (op) => [T(`Run ${String(op.params.profile)} stock along the sketch lines.`)] },
  { kind: "import", op: "feature.import", label: "Import", params: [], sentence: (op) => [T(`Import a ${String(op.params.format ?? "file")} body.`)] },
  { kind: "surface", op: "feature.surface", label: "Surface", params: [mm("distance", "Distance", 0.5, 500)],
    sentence: (op) => [T(`Make a ${String(op.params.mode)} surface`), ...(op.params.distance != null ? [T(" "), P("distance"), T(" deep")] : []), T(".")] },
  { kind: "stitch", op: "feature.stitch", label: "Stitch", params: [], sentence: () => [T("Sew the surfaces together.")] },
  { kind: "thicken", op: "feature.thicken", label: "Thicken", params: [mm("thickness", "Thickness", 0.1, 50, 0.1)], pushParam: "thickness",
    sentence: () => [T("Thicken the surface by "), P("thickness"), T(".")] },
  { kind: "trim", op: "feature.trim", label: "Trim", params: [], sentence: () => [T("Trim the surface.")] },
  { kind: "untrim", op: "feature.untrim", label: "Untrim", params: [], sentence: () => [T("Restore the trimmed surface.")] },
  { kind: "thread", op: "feature.thread", label: "Thread", params: [], sentence: (op) => [T(`Cut a ${String(op.params.spec ?? "")} thread.`)] },
  { kind: "loft", op: "feature.loft", label: "Loft", params: [], sentence: (op) => [T(`Loft through ${Array.isArray(op.params.sketches) ? op.params.sketches.length : 2} profiles`), T(opVerb(op.params.operation)), T(".")] },
  { kind: "sweep", op: "feature.sweep", label: "Sweep", params: [],
    sentence: (op, names) => [T("Sweep "), { ref: String(op.params.profile), text: names(String(op.params.profile)) }, T(" along "), { ref: String(op.params.path), text: names(String(op.params.path)) }, T(opVerb(op.params.operation)), T(".")] },
];

const BY_KIND = new Map(SPECS.map((s) => [s.kind, s]));
const BY_OP = new Map(SPECS.map((s) => [s.op, s]));

export function featureSpec(kind: FeatureDef["kind"]): FeatureSpec | undefined { return BY_KIND.get(kind); }
export function featureSpecForOp(op: string): FeatureSpec | undefined { return BY_OP.get(op); }
export function allFeatureSpecs(): FeatureSpec[] { return SPECS; }

/** A feature as every surface sees it: the op that made it, its spec, its number in the history, its values. */
export interface FeatureRow {
  featureId: string;
  opId: string;
  op: OperationRecord;
  spec: FeatureSpec;
  /** 1-based position among feature ops (the pin / chip number). */
  num: number;
  /** Index of the op in the timeline. */
  index: number;
  name: string;
  /** Evaluated value of each editable param (NaN when the expression fails). */
  values: Record<string, number>;
  /** The raw expression text of each param. */
  exprs: Record<string, string>;
  suppressed: boolean;
  /** Past the rollback marker: exists but isn't built. */
  rolledBack: boolean;
  error?: string;
  /** The body row this feature made or modified, when known. */
  solid?: SolidEval;
  /** The component the feature's body belongs to (root when unknown). */
  componentId: string;
}

/** Evaluate a param expression against the document's parameters. */
export function evalParam(doc: CadDocument, expr: unknown): number {
  if (typeof expr === "number") return expr;
  if (typeof expr !== "string") return NaN;
  try {
    const { scope } = resolveParameters(doc.parameters);
    const v = compileExpr(expr).eval(scope);
    return Number.isFinite(v) ? v : NaN;
  } catch { return Number(expr); }
}

/** The feature rows of a session, in history order. The single source for pins, cards, prose and strips. */
export function featureRows(doc: CadDocument, timeline: OperationRecord[], rollbackIndex: number, solids: Record<string, SolidEval>): FeatureRow[] {
  const rows: FeatureRow[] = [];
  let num = 0;
  timeline.forEach((op, index) => {
    const spec = BY_OP.get(op.type);
    if (!spec) return;
    num++;
    const featureId = op.createdIds[0] ?? op.opId;
    const f = doc.features[featureId] as (FeatureDef & { name?: string }) | undefined;
    const values: Record<string, number> = {}, exprs: Record<string, string> = {};
    for (const p of spec.params) {
      const raw = op.params[p.key];
      if (raw == null) continue;
      exprs[p.key] = String(raw);
      values[p.key] = evalParam(doc, raw);
    }
    const bodyId = typeof op.params.body === "string" ? op.params.body : featureId;
    const solid = solids[featureId] ?? solids[bodyId];
    const sketchId = typeof op.params.sketch === "string" ? op.params.sketch : solid?.sketchId;
    const componentId = (sketchId && doc.sketches[sketchId]?.componentId) || doc.rootComponentId;
    rows.push({
      featureId, opId: op.opId, op, spec, num, index,
      name: f?.name || (typeof op.params.name === "string" && op.params.name) || `${spec.label} ${num}`,
      values, exprs, suppressed: !!op.suppressed, rolledBack: index >= rollbackIndex, error: op.error, solid, componentId,
    });
  });
  return rows;
}

/** Display name for a sketch / feature id, for sentences. */
export function nameOf(doc: CadDocument, id: string): string {
  const sk = doc.sketches[id];
  if (sk) return sk.name || "the sketch";
  const f = doc.features[id] as { name?: string } | undefined;
  return f?.name || id;
}

/** Where a feature's pin anchors in world space: a hole's first centre, else the top of its body's bounds. */
export function pinAnchor(row: FeatureRow): { x: number; y: number; z: number } | null {
  const at = row.op.params.at;
  if (Array.isArray(at) && at[0] && typeof at[0].x === "number") return { x: at[0].x, y: at[0].y, z: at[0].z };
  const b = row.solid?.bounds;
  if (b) {
    // spread pins of one body apart by feature number so stacked modifiers don't land on one point
    const k = (row.num % 4) / 4;
    return { x: b.min.x + (b.max.x - b.min.x) * (0.3 + 0.4 * k), y: b.min.y + (b.max.y - b.min.y) * (0.7 - 0.4 * k), z: b.max.z };
  }
  const c = row.solid?.centroid;
  return c ? { x: c.x, y: c.y, z: c.z } : null;
}

/** The sentence of a row with its live values filled in, as plain text (for tests, search and the agent). */
export function sentenceText(row: FeatureRow, doc: CadDocument): string {
  return row.spec.sentence(row.op, (id) => nameOf(doc, id)).map((s) => {
    if ("text" in s && !("ref" in s)) return s.text;
    if ("ref" in s) return s.text;
    const p = row.spec.params.find((q) => q.key === s.param);
    const v = row.values[s.param];
    const unit = p?.unit === "deg" ? "°" : p?.unit ? ` ${p.unit}` : "";
    return Number.isFinite(v) ? `${v}${unit}` : `${row.exprs[s.param] ?? "?"}${unit}`;
  }).join("");
}
