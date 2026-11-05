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

/** The unit as a live number shows it after a value: "mm", "°" for degrees, nothing for a count. */
export function unitLabel(unit: Unit | string): string {
  return unit === "deg" ? "°" : unit;
}

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
  /** The op param a Push/Pull on this feature's face drives, when one param is the natural choice
   *  (a primitive's depends on its shape: see `pushParamFor`). */
  pushParam?: string;
}

const mm = (key: string, label: string, min: number, max: number, step = 0.5): ParamSpec => ({ key, label, unit: "mm", min, max, step });
const deg = (key: string, label: string): ParamSpec => ({ key, label, unit: "deg", min: -360, max: 360, step: 1 });
const count = (key: string, label: string, max = 50): ParamSpec => ({ key, label, unit: "", min: 1, max, step: 1, count: true });
const T = (text: string): Segment => ({ text });
const P = (param: string): Segment => ({ param });
const opVerb = (o: unknown) => (o === "cut" ? " cut from the body" : o === "join" ? " joined to the body" : o === "intersect" ? " kept where it meets the body" : "");

const SPECS: FeatureSpec[] = [
  // negative distances extrude the other way (a formula may well be negative): no clamp that flips the back
  { kind: "extrude", op: "feature.extrude", label: "Extrude", params: [mm("distance", "Distance", -500, 500)], pushParam: "distance",
    sentence: (op, names) => [T("Extrude "), { ref: String(op.params.sketch), text: names(String(op.params.sketch)) },
      ...(op.params.extent === "toFace" ? [T(" up to a face")] : op.params.extent === "throughAll" ? [T(" through everything")] : [T(" by "), P("distance"), T(op.params.symmetric ? " each way" : "")]),
      T(opVerb(op.params.operation)), T(".")] },
  { kind: "revolve", op: "feature.revolve", label: "Revolve", params: [deg("angle", "Angle")], pushParam: "angle",
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
  { kind: "gear", op: "feature.gear", label: "Gear", pushParam: "faceWidth",
    params: [mm("module", "Module", 0.2, 10, 0.1), count("teeth", "Teeth", 200), mm("faceWidth", "Face width", 0.5, 200),
      { key: "helixAngle", label: "Helix", unit: "deg", min: -45, max: 45, step: 1 }, mm("backlash", "Backlash", 0, 1, 0.05),
      mm("bore", "Bore", 0, 100), mm("hubDiameter", "Hub ⌀", 0, 200), mm("hubLength", "Hub length", 0, 100), count("spokes", "Spokes", 12)],
    sentence: (op) => {
      const type = String(op.params.type ?? "spur");
      const noun = type === "ring" ? "ring gear" : type === "rack" ? "rack" : type === "worm" ? "worm" : `${type} gear`;
      const has = (k: string) => op.params[k] != null;
      return [
        T("Make a "), ...(has("teeth") ? [P("teeth"), T(type === "worm" ? "-start " : "-tooth ")] : []), T(noun),
        ...(has("module") ? [T(", module "), P("module")] : []),
        ...(has("faceWidth") ? [T(", "), P("faceWidth"), T(type === "worm" ? " long" : " wide")] : []),
        ...(has("helixAngle") ? [T(", helix "), P("helixAngle")] : []),
        ...(has("bore") ? [T(", bored "), P("bore")] : []),
        ...(op.params.mesh ? [T(", meshed with its mate")] : []),
        T(opVerb(op.params.operation)), T("."),
      ];
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
  { kind: "draft", op: "feature.draft", label: "Draft", params: [{ key: "angle", label: "Angle", unit: "deg", min: -30, max: 30, step: 0.5 }], pushParam: "angle",
    sentence: () => [T("Draft the walls by "), P("angle"), T(" for the mould.")] },
  { kind: "pattern", op: "feature.pattern", label: "Pattern", params: [count("count", "Count")], pushParam: "count",
    sentence: (op) => [T(`Repeat it ${op.params.mode === "circular" ? "around" : "along a line"}, `), P("count"), T(" times.")] },
  { kind: "voronoi", op: "feature.voronoi", label: "Voronoi", params: [count("cells", "Cells", 400), mm("web", "Web", 0.4, 20, 0.1), mm("round", "Corner radius", 0, 10, 0.1)], pushParam: "web",
    sentence: () => [T("Cut "), P("cells"), T(" Voronoi openings round it, leaving a "), P("web"), T(" web.")] },
  { kind: "mirror", op: "feature.mirror", label: "Mirror", params: [],
    sentence: (op) => [T(`Mirror it across the ${String(op.params.plane)} plane.`)] },
  { kind: "sheet", op: "feature.sheet", label: "Sheet", params: [mm("thickness", "Thickness", 0.1, 25, 0.1), mm("radius", "Bend radius", 0, 25, 0.1)], pushParam: "thickness",
    sentence: (op, names) => [T("Make a sheet from "), { ref: String(op.params.sketch), text: names(String(op.params.sketch)) }, T(", "), P("thickness"), T(" thick.")] },
  { kind: "flange", op: "feature.flange", label: "Flange", params: [mm("length", "Length", 0.5, 500), deg("angle", "Angle"), mm("radius", "Bend radius", 0, 25, 0.1)], pushParam: "length",
    sentence: (op) => [T(`Add a flange on ${String(op.params.edge)}, `), P("length"), T(" long"), ...(op.params.angle != null ? [T(" at "), P("angle")] : []), T(".")] },
  { kind: "fold", op: "feature.fold", label: "Fold", params: [deg("angle", "Angle"), mm("radius", "Bend radius", 0, 25, 0.1)], pushParam: "angle",
    sentence: () => [T("Fold along the line by "), P("angle"), T(".")] },
  { kind: "sheet", op: "feature.sheet.edit", label: "Folds", params: [],
    sentence: (op) => [T(`Set the sheet's ${Array.isArray(op.params.folds) ? `${(op.params.folds as unknown[]).length} folds` : "folds"}${Array.isArray(op.params.cuts) && (op.params.cuts as unknown[]).length ? ` and ${(op.params.cuts as unknown[]).length} cuts` : ""}.`)] },
  { kind: "unfold", op: "feature.unfold", label: "Unfold", params: [], sentence: () => [T("Unfold it flat.")] },
  { kind: "refold", op: "feature.refold", label: "Refold", params: [], sentence: () => [T("Fold it back up.")] },
  { kind: "member", op: "feature.member", label: "Member", params: [],
    sentence: (op) => [T(`Run ${String(op.params.profile)} stock along the sketch lines.`)] },
  { kind: "import", op: "feature.import", label: "Import", params: [], sentence: (op) => [T(`Import a ${String(op.params.format ?? "file")} body.`)] },
  { kind: "surface", op: "feature.surface", label: "Surface", params: [mm("distance", "Distance", 0.5, 500)], pushParam: "distance",
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
  /** This feature's own solid row (a modifier's row carries no geometry). */
  solid?: SolidEval;
  /** For a modifier whose own row has no geometry (fillet, shell, pattern…): the body it changed —
   *  `op.params.body`, else, as the kernel resolves "the most recent body", the latest earlier body.
   *  Undefined when `solid` itself has geometry. Pins anchor on `solid`, else here. */
  body?: SolidEval;
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
    const values: Record<string, number> = {}, exprs: Record<string, string> = {};
    for (const p of spec.params) {
      const raw = op.params[p.key];
      if (raw == null) continue;
      if (p.key === "distance" && (op.params.extent === "toFace" || op.params.extent === "throughAll")) continue; // the extent decides, not a number
      exprs[p.key] = String(raw);
      values[p.key] = evalParam(doc, raw);
    }
    const bodyId = typeof op.params.body === "string" ? op.params.body : featureId;
    const solid = solids[featureId] ?? solids[bodyId];
    const body = resolveBody(solid, typeof op.params.body === "string" ? solids[op.params.body] : undefined, rows);
    const sketchId = typeof op.params.sketch === "string" ? op.params.sketch : solid?.sketchId || body?.sketchId;
    const componentId = (sketchId && doc.sketches[sketchId]?.componentId) || doc.rootComponentId;
    rows.push({
      featureId, opId: op.opId, op, spec, num, index,
      // one name wherever it shows (strip, card, Timeline), built or rolled back: the one it was given, else what it is
      name: (typeof op.params.name === "string" && op.params.name.trim()) || defaultFeatureName(op, spec),
      // the command's error, else the kernel's: a feature that failed to build must say so, not show as built
      values, exprs, suppressed: !!op.suppressed, rolledBack: index >= rollbackIndex, error: op.error ?? solid?.error, solid, body, componentId,
    });
  });
  return rows;
}

const hasGeometry = (s: SolidEval | undefined): s is SolidEval => !!s && (!!s.bounds || !!s.centroid);

/** What a feature is called when it was given no name: what it is ("Box", "Circular pattern", "Fillet"); its number
 *  sits beside it wherever it shows, so two fillets read "2 · Fillet" and "4 · Fillet". */
export function defaultFeatureName(op: Pick<OperationRecord, "params">, spec: Pick<FeatureSpec, "kind" | "label">): string {
  if (spec.kind === "primitive") { const sh = String(op.params.shape ?? "box"); return sh[0].toUpperCase() + sh.slice(1); }
  if (spec.kind === "pattern") return op.params.mode === "circular" ? "Circular pattern" : "Linear pattern";
  return spec.label;
}

/** The body a modifier changed: the named target, else the latest earlier body with geometry
 *  (the kernel's "most recent body" rule). Undefined when the row's own solid has geometry. */
function resolveBody(own: SolidEval | undefined, named: SolidEval | undefined, earlier: FeatureRow[]): SolidEval | undefined {
  if (hasGeometry(own)) return undefined;
  if (hasGeometry(named)) return named;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const r = earlier[i];
    if (hasGeometry(r.solid)) return r.solid;
    if (hasGeometry(r.body)) return r.body;
  }
  return undefined;
}

/** Display name for a sketch / feature id, for sentences. The document knows only what is built, so a
 *  sketch or feature rolled back out of it is named from the timeline: the op whose createdIds hold the id
 *  (its `params.name`, else "Sketch N" numbered among sketch.create ops as the Timeline panel numbers them,
 *  else the feature's label and number as `featureRows` names it). The raw id only when nothing knows it. */
export function nameOf(doc: CadDocument, timeline: OperationRecord[], id: string): string {
  const sk = doc.sketches[id];
  if (sk) return sk.name || "the sketch";
  const f = doc.features[id] as { name?: string } | undefined;
  if (f?.name) return f.name;
  return nameFromTimeline(timeline, id) ?? id;
}

/** The name the timeline gives an id (see `nameOf`); undefined when no op created it. */
export function nameFromTimeline(timeline: OperationRecord[], id: string): string | undefined {
  let sketches = 0, features = 0;
  for (const op of timeline) {
    const isSketch = op.type === "sketch.create", spec = isSketch ? undefined : BY_OP.get(op.type);
    if (isSketch) sketches++;
    else if (spec) features++;
    if (!op.createdIds.includes(id)) continue;
    if (typeof op.params.name === "string" && op.params.name) return op.params.name;
    if (isSketch) return `Sketch ${sketches}`;
    if (spec) return defaultFeatureName(op, spec); // as featureRows names it: the same built or rolled back (M14)
    return undefined;
  }
  return undefined;
}

type P3 = { x: number; y: number; z: number };

/** Whether `p` lies on triangle `t` (within a hair of its plane, and inside its edges). */
function onTriangle(p: P3, [a, b, c]: [P3, P3, P3]): boolean {
  const v0 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v1 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }, v2 = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const dot = (u: P3, v: P3) => u.x * v.x + u.y * v.y + u.z * v.z;
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-12) return false;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, eps = 1e-6;
  if (v < -eps || w < -eps || v + w > 1 + eps) return false;
  const q = { x: a.x + v * v0.x + w * v1.x - p.x, y: a.y + v * v0.y + w * v1.y - p.y, z: a.z + v * v0.z + w * v1.z - p.z };
  return Math.hypot(q.x, q.y, q.z) < 1e-3 * Math.max(1, Math.sqrt(d00), Math.sqrt(d11));
}

/** A face "looks up" when its normal's z is at least this: tilted back at least about 17° from vertical, so a
 *  leaning plate counts and a wall doesn't. */
const UP_FACING = 0.3;

/** A point on the largest upward-facing face `featureId` made in `mesh` (else its largest face; faces are named
 *  "<feature id>:<face>"): the centre of that face's triangle nearest its area-weighted centre, so it lies on the
 *  surface even for an L-shaped face. Null when the mesh names no face for the feature. */

export function faceAnchor(mesh: { positions: Float32Array; indices: Uint32Array; faceRanges?: number[]; faceNames?: string[] } | undefined, featureId: string): P3 | null {
  if (!mesh?.faceRanges || !mesh.faceNames) return null;
  const P = mesh.positions, I = mesh.indices, prefix = `${featureId}:`;
  const faces: { area: number; up: number; tris: { c: P3; a: number; tri: [P3, P3, P3] }[] }[] = [];
  mesh.faceNames.forEach((name, k) => {
    if (!name.startsWith(prefix)) return;
    const start = mesh.faceRanges![2 * k], count = mesh.faceRanges![2 * k + 1];
    const tris: { c: P3; a: number; tri: [P3, P3, P3] }[] = [];
    let area = 0, nx = 0, ny = 0, nz = 0;
    for (let i = start; i + 2 < start + count && i + 2 < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const t = 0.5 * Math.hypot(cx, cy, cz);
      const pt = (j: number): P3 => ({ x: P[j], y: P[j + 1], z: P[j + 2] });
      tris.push({ c: { x: (P[a] + P[b] + P[c]) / 3, y: (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z: (P[a + 2] + P[b + 2] + P[c + 2]) / 3 }, a: t, tri: [pt(a), pt(b), pt(c)] });
      area += t; nx += cx; ny += cy; nz += cz;
    }
    if (tris.length) faces.push({ area, up: nz / (Math.hypot(nx, ny, nz) || 1), tris });
  });
  // The largest face that looks up, else the largest: a box's pin stays on its top while it's resized, instead of
  // jumping between whichever side is biggest at the moment.
  const largest = (list: typeof faces) => list.reduce<(typeof faces)[number] | null>((b, f) => (!b || f.area > b.area ? f : b), null);
  const best = largest(faces.filter((f) => f.up >= UP_FACING)) ?? largest(faces);
  if (!best) return null;
  const { area, tris } = best;
  const m = tris.reduce((s, t) => ({ x: s.x + t.c.x * t.a, y: s.y + t.c.y * t.a, z: s.z + t.c.z * t.a }), { x: 0, y: 0, z: 0 });
  const g = { x: m.x / area, y: m.y / area, z: m.z / area };
  // the centre itself when it lies on the face (any convex face): it moves smoothly as the face is resized, where the
  // nearest triangle's centre would hop between triangles
  if (tris.some((t) => t.tri && onTriangle(g, t.tri))) return g;
  return tris.reduce((b, t) => (Math.hypot(t.c.x - g.x, t.c.y - g.y, t.c.z - g.z) < Math.hypot(b.x - g.x, b.y - g.y, b.z - g.z) ? t.c : b), tris[0].c);
}

/** Where a feature's pin anchors in world space: a hole's first centre, else a point on the largest face the feature
 *  made (so the leader lands on its own geometry, not in the air above a body it was joined into), else the top of
 *  the bounds of the body it made or modified (`row.body`; a bare `solid` for callers that build rows by hand). */
export function pinAnchor(row: FeatureRow): { x: number; y: number; z: number } | null {
  const at = row.op.params.at;
  if (Array.isArray(at) && at[0] && typeof at[0].x === "number") return { x: at[0].x, y: at[0].y, z: at[0].z };
  const geo = hasGeometry(row.solid) ? row.solid : row.body;
  const onFace = faceAnchor(geo?.mesh, row.featureId) ?? (row.body && row.body !== geo ? faceAnchor(row.body.mesh, row.featureId) : null);
  if (onFace) return onFace;
  const b = geo?.bounds;
  if (b) {
    // spread pins of one body apart by feature number so stacked modifiers don't land on one point
    const k = (row.num % 4) / 4;
    return { x: b.min.x + (b.max.x - b.min.x) * (0.3 + 0.4 * k), y: b.min.y + (b.max.y - b.min.y) * (0.7 - 0.4 * k), z: b.max.z };
  }
  const c = geo?.centroid;
  return c ? { x: c.x, y: c.y, z: c.z } : null;
}

/** The sentence of a row with its live values filled in, as plain text (for tests, search and the agent). */
export function sentenceText(row: FeatureRow, doc: CadDocument, timeline: OperationRecord[]): string {
  return row.spec.sentence(row.op, (id) => nameOf(doc, timeline, id)).map((s) => {
    if ("text" in s && !("ref" in s)) return s.text;
    if ("ref" in s) return s.text;
    const p = row.spec.params.find((q) => q.key === s.param);
    const u = p ? unitLabel(p.unit) : "";
    const unit = u === "°" ? u : u ? ` ${u}` : "";
    const v = row.values[s.param];
    return Number.isFinite(v) ? `${v}${unit}` : `${row.exprs[s.param] ?? "?"}${unit}`;
  }).join("");
}

/** The params editOperation receives for a row with one value changed (values travel as expression text). */
export function paramsWith(row: Pick<FeatureRow, "op">, key: string, value: number): Record<string, unknown> {
  return { ...row.op.params, [key]: String(value) };
}

/** The op param a Push/Pull on one of the row's faces drives: the spec's `pushParam` when the op carries it,
 *  else the first of the spec's params the op actually has (a primitive's x, else its radius; a flange's
 *  length). Undefined for a feature with no number to push (mirror, stitch, a flange with none set). */
export function pushParamFor(row: Pick<FeatureRow, "spec" | "exprs">): string | undefined {
  const fixed = row.spec.pushParam;
  if (fixed && row.exprs[fixed] != null) return fixed;
  return row.spec.params.find((p) => row.exprs[p.key] != null)?.key;
}

export type Bounds3Like = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** The box around every box in the list (null for none). */
export function unionBounds<B extends Bounds3Like>(list: B[]): Bounds3Like | null {
  if (!list.length) return null;
  const u: Bounds3Like = { min: { ...list[0].min }, max: { ...list[0].max } };
  for (const b of list) {
    u.min = { x: Math.min(u.min.x, b.min.x), y: Math.min(u.min.y, b.min.y), z: Math.min(u.min.z, b.min.z) };
    u.max = { x: Math.max(u.max.x, b.max.x), y: Math.max(u.max.y, b.max.y), z: Math.max(u.max.z, b.max.z) };
  }
  return u;
}

/** The centre of a bounding box. */
export function boundsCentre(b: Bounds3Like): { x: number; y: number; z: number } {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
}
