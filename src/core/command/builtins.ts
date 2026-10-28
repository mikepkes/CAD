// Built-in commands. Every mutation the UI or an agent performs is one of
// these. Each is documented with a JSON Schema + examples so it can be exposed
// directly as an MCP tool.

import { CadDocument, Material, RoleRef } from "../document";
import {
  DimensionConstraint,
  GeometricConstraint,
  Sketch,
  SketchPoint,
} from "../../sketch/types";
import { CommandRegistry } from "./registry";
import { CommandContext, CommandDef, JSONSchema } from "./types";
import { makePlaneFromNormal, offsetPlane, planeById, WorkPlane } from "../../geometry/plane";
import { Vec3 } from "../../math/vec";
import { compileExpr } from "../../math/expr";
import { resolveParameters } from "../../model/parameters";
import { ProjectedCurve } from "../geometry/project";
import { blendCorner, copyEntities, extendCurve, offsetCurve, trimCurve, Vec } from "./sketch-ops";
import { gearOutline, GearType } from "../geometry/gear";

const PLANE_ENUM = ["XY", "XZ", "YZ"];

// A point given either as coordinates (creates a new point) or a ref to an
// existing point id (reuses it — which is how coincidence is expressed).
const POINT_REF_SCHEMA: JSONSchema = {
  description: "A point: either {x,y} to create one, or {ref: <pointId>} to reuse an existing one. x/y may be expressions in the parameters (e.g. \"width/2 - 3\"): such a point is fixed there and follows the parameters.",
  oneOf: [
    { type: "object", required: ["x", "y"], properties: { x: { type: ["number", "string"] }, y: { type: ["number", "string"] } } },
    { type: "object", required: ["ref"], properties: { ref: { type: "string" } } },
  ],
};

const CONSTRUCTION_SCHEMA: JSONSchema = {
  type: "boolean",
  description: "Construction (reference) geometry: drawn dashed and excluded from filled profiles / extrusion.",
};

type PointRef = { x: number | string; y: number | string } | { ref: string };
type EdgeSelectorParams = import("../document").EdgeSelector;
type FaceSelectorParams = import("../document").FaceSelector;
type ThreadSpecParams = import("../document").ThreadSpec;

const V3_SCHEMA: JSONSchema = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } };
const ROLE_REF_SCHEMA: JSONSchema = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: {
    role: { type: "string", enum: ["self", "prev", "root"], description: "self → instance i, prev → i-1, root → ground." },
    component: { type: "string", description: "Source component whose per-instance clone this addresses (self/prev)." },
    port: { type: "string", description: "Connector name on that component." },
    origin: { ...V3_SCHEMA, description: "Raw local origin when there is no named port (e.g. a ground anchor)." },
  },
};
const IN_PLANE_SCHEMA: JSONSchema = {
  type: "object",
  required: ["plane"],
  properties: { plane: { type: "string", enum: PLANE_ENUM }, offset: { type: "number", description: "Offset along the plane normal (mm)." } },
};
const EDGE_SELECTOR_SCHEMA: JSONSchema = {
  type: "object",
  description: "Which edges (AND of every set field; empty = all edges).",
  additionalProperties: false,
  properties: {
    parallelTo: { type: "string", enum: ["X", "Y", "Z"], description: "Edge direction parallel to a world axis." },
    inPlane: { ...IN_PLANE_SCHEMA, description: "Edges lying in an origin plane offset along its normal (a face outline)." },
    curveType: { type: "string", enum: ["line", "circle"] },
    minLength: { type: "number" },
    maxLength: { type: "number" },
    nearPoint: { ...V3_SCHEMA, description: "Edges passing through this world point." },
    inBox: { type: "object", required: ["min", "max"], properties: { min: V3_SCHEMA, max: V3_SCHEMA }, description: "Edges entirely inside this world box." },
  },
};
const FACE_SELECTOR_SCHEMA: JSONSchema = {
  type: "object",
  description: "Which faces (AND of every set field).",
  additionalProperties: false,
  properties: {
    parallelTo: { type: "string", enum: PLANE_ENUM, description: "Planar faces parallel to an origin plane." },
    inPlane: { ...IN_PLANE_SCHEMA, description: "Faces lying in an origin plane offset along its normal." },
    nearPoint: { ...V3_SCHEMA, description: "The face containing this world point." },
  },
};

const THREAD_SPEC_SCHEMA: JSONSchema = {
  type: "object",
  required: ["form", "pitch", "diameter", "length"],
  additionalProperties: false,
  description: "A thread definition (shared by feature.thread and threaded holes).",
  properties: {
    form: { type: "string", enum: ["metric", "unified", "acme", "trapezoidal", "square", "buttress", "ballscrew", "custom"] },
    pitch: { type: "number", description: "Axial distance per turn, per start (mm)." },
    diameter: { type: "number", description: "Major (nominal) diameter (mm)." },
    length: { type: "number", description: "Threaded length (mm)." },
    internal: { type: "boolean", description: "Cut as an internal thread (a nut/bore) vs external (a screw)." },
    leftHand: { type: "boolean" },
    starts: { type: "integer", description: "Number of starts (multi-start). Default 1." },
    depth: { type: "number", description: "Radial thread height override (mm)." },
    representation: { type: "string", enum: ["cosmetic", "modeled"], description: "cosmetic (default) = a plain cylinder shaded as a thread by a normal-map texture (cheap, exports as a plain cylinder); modeled = real helical geometry." },
    profilePoints: { type: "array", items: { type: "object", required: ["x", "y"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" } } }, description: "custom form only: axial section points (x = radial height, y = axial)." },
  },
};

const norm2 = (v: Vec): Vec => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; };

/** Ids of the (non-construction) lines that end at point `pid`. */
function linesAt(sk: Sketch, pid: string): string[] {
  return Object.values(sk.entities).filter((e) => e.kind === "line" && !e.construction && (e.p1 === pid || e.p2 === pid)).map((e) => e.id);
}

/** The two lines of a corner: given explicitly, or the pair meeting at `point`. */
function cornerLines(sk: Sketch, p: { line1?: string; line2?: string; point?: string }): [string, string] {
  if (p.line1 && p.line2) return [p.line1, p.line2];
  if (!p.point) throw new Error("give line1 + line2, or a corner point");
  const ls = linesAt(sk, p.point);
  if (ls.length !== 2) throw new Error(`point ${p.point} is shared by ${ls.length} lines; need exactly 2`);
  return [ls[0], ls[1]];
}

/** Order a set of lines into one closed loop, returning its point ids in walk order. */
function orderLoop(sk: Sketch, lineIds: string[]): string[] {
  const lines = lineIds.map((id) => {
    const e = sk.entities[id];
    if (!e || e.kind !== "line") throw new Error(`"${id}" is not a line`);
    return e;
  });
  if (lines.length < 3) throw new Error("a loop needs at least 3 lines");
  const adj = new Map<string, string[]>();
  for (const l of lines) {
    adj.set(l.p1, [...(adj.get(l.p1) ?? []), l.p2]);
    adj.set(l.p2, [...(adj.get(l.p2) ?? []), l.p1]);
  }
  for (const [pid, nb] of adj) if (nb.length !== 2) throw new Error(`point ${pid} is not shared by exactly two of the given lines — not a single closed loop`);
  const start = lines[0].p1;
  const order = [start];
  let prev = "", cur = start;
  while (true) {
    const [a, b] = adj.get(cur)!;
    const next = a === prev ? b : a;
    if (next === start) break;
    if (order.includes(next)) throw new Error("lines do not form a single closed loop");
    order.push(next); prev = cur; cur = next;
  }
  if (order.length !== lines.length) throw new Error("lines do not form a single closed loop");
  return order;
}

function sketchOf(doc: CadDocument, id: unknown): Sketch {
  const sk = doc.sketches[String(id)];
  if (!sk) throw new Error(`No sketch "${id}"`);
  return sk;
}

function resolvePoint(sk: Sketch, ref: PointRef, ctx: CommandContext, draft?: CadDocument): string {
  if ("ref" in ref) {
    if (!sk.entities[ref.ref]) throw new Error(`No entity "${ref.ref}" in sketch`);
    return ref.ref;
  }
  // evaluate before allocating: a failed command must not have created ids
  const pt = draft ? parametricPoint(draft, "", ref.x, ref.y) : { id: "", kind: "point" as const, x: Number(ref.x), y: Number(ref.y) };
  const id = ctx.alloc("pt");
  sk.entities[id] = { ...pt, id };
  return id;
}

/** A point at (x, y), where either may be an expression in the parameters: such
 *  a point is fixed at its evaluated position and re-evaluated every recompute. */
function parametricPoint(draft: CadDocument, id: string, x: number | string, y: number | string, fixed?: boolean): SketchPoint {
  if (typeof x === "number" && typeof y === "number") return { id, kind: "point", x, y, ...(fixed ? { fixed } : {}) };
  const scope = resolveParameters(draft.parameters).scope;
  const ev = (v: number | string) => {
    if (typeof v === "number") return v;
    const n = compileExpr(v).eval(scope);
    if (!Number.isFinite(n)) throw new Error(`point coordinate "${v}" is not a number`);
    return n;
  };
  return { id, kind: "point", x: ev(x), y: ev(y), fixed: true, xExpr: String(x), yExpr: String(y) };
}

// Arc geometry for sketch.addProfile.
const signedArea2 = (a: Vec, b: Vec, c: Vec) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** Circumcentre of three points (null if collinear). */
function circumcentre(a: Vec, b: Vec, c: Vec): Vec | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}
/** Centre of the minor arc of radius `r` from a→c, bulging to the left of a→c when `left`. */
function arcCentreFromRadius(a: Vec, c: Vec, r: number, left: boolean): { center: Vec; ccw: boolean } {
  const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
  if (d < 1e-9) throw new Error("profile arc endpoints coincide");
  if (r < d / 2 - 1e-9) throw new Error(`profile arc radius ${r} too small for the ${d.toFixed(3)} span`);
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
  const px = -dy / d, py = dx / d, s = left ? 1 : -1;
  const center = { x: (a.x + c.x) / 2 + px * h * s, y: (a.y + c.y) / 2 + py * h * s };
  const cross = (a.x - center.x) * (c.y - center.y) - (a.y - center.y) * (c.x - center.x);
  return { center, ccw: cross > 0 };
}

export function createDefaultRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const def of BUILTINS) reg.register(def);
  return reg;
}

/** Validate and normalize a parameter's optional extents/enum. A parameter may
 *  carry extents (min and/or max) OR a list of acceptable values, never both. */
function normalizeBounds(p: { min?: number; max?: number; values?: number[] }): { min?: number; max?: number; values?: number[] } {
  const hasExtent = p.min != null || p.max != null;
  const hasValues = Array.isArray(p.values) && p.values.length > 0;
  if (hasExtent && hasValues) throw new Error("a parameter can have extents or a value list, not both");
  if (hasValues) {
    const vals = [...new Set(p.values!)].sort((a, b) => a - b);
    return { values: vals };
  }
  if (p.min != null && p.max != null && p.min > p.max) throw new Error(`min (${p.min}) must be ≤ max (${p.max})`);
  const out: { min?: number; max?: number } = {};
  if (p.min != null) out.min = p.min;
  if (p.max != null) out.max = p.max;
  return out;
}

type ExprVec3 = { x: number | string; y: number | string; z: number | string };
/** A point whose coordinates may be expressions: evaluated now, the expressions
 *  kept (so it follows the parameters). */
function exprPoint(o: ExprVec3, scope: Record<string, number>, what: string): { value: { x: number; y: number; z: number }; exprs?: Partial<Record<"x" | "y" | "z", string>> } {
  const value = { x: 0, y: 0, z: 0 };
  const exprs: Partial<Record<"x" | "y" | "z", string>> = {};
  for (const k of ["x", "y", "z"] as const) {
    const v = o[k];
    const n = typeof v === "number" ? v : compileExpr(String(v)).eval(scope);
    if (!Number.isFinite(n)) throw new Error(`${what}.${k} does not evaluate (${v})`);
    if (typeof v === "string") exprs[k] = v;
    value[k] = n;
  }
  return Object.keys(exprs).length ? { value, exprs } : { value };
}

/** A flexure strip's dimensions: numbers as given, expressions evaluated (and
 *  kept, so they follow the parameters). Each must come out positive. */
function flexureSection(f: { length: number | string; width: number | string; thickness: number | string }, scope: Record<string, number>): { length: number; width: number; thickness: number; exprs?: Partial<Record<"length" | "width" | "thickness", string>> } {
  const out = { length: 0, width: 0, thickness: 0 };
  const exprs: Partial<Record<"length" | "width" | "thickness", string>> = {};
  for (const k of ["length", "width", "thickness"] as const) {
    const v = f[k];
    const n = typeof v === "number" ? v : compileExpr(String(v)).eval(scope);
    if (typeof v === "string") exprs[k] = v;
    if (!(Number.isFinite(n) && n > 0)) throw new Error(`flexure ${k} must be positive (got ${v} = ${n})`);
    out[k] = n;
  }
  return Object.keys(exprs).length ? { ...out, exprs } : out;
}

/** A named choice's names: at least two, distinct, and nothing else bounding it. */
function checkOptions(p: { min?: number; max?: number; step?: number; values?: number[]; boolean?: boolean; options?: string[] }): string[] {
  if (p.min != null || p.max != null || p.step != null || p.values || p.boolean) throw new Error("a named choice takes no extents, value list or checkbox");
  const names = p.options!.map((o) => String(o).trim());
  if (names.length < 2) throw new Error("a named choice needs at least two options");
  if (names.some((n) => !n)) throw new Error("an option name is empty");
  if (new Set(names).size !== names.length) throw new Error("option names must be distinct");
  return names;
}

export const BUILTINS: CommandDef<any>[] = [
  // ---- parameters ----
  {
    type: "parameter.add",
    title: "Add parameter",
    summary: "Create a named parameter usable in any dimension expression.",
    description:
      "Adds a parameter (name + expression). Expressions may reference other parameters and functions (e.g. 'width/2', 'rad(30)'). Names must be unique and match [A-Za-z_][A-Za-z0-9_]*.",
    paramsSchema: {
      type: "object",
      required: ["name", "expression"],
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Unique parameter name." },
        expression: { type: "string", description: "Expression, e.g. '40' or 'width/2'." },
        min: { type: "number", description: "Optional lower extent (for a slider / validation)." },
        max: { type: "number", description: "Optional upper extent." },
        step: { type: "number", exclusiveMinimum: 0, description: "Optional increment: the slider snaps to multiples of this. `step: 1` makes the parameter integer-only." },
        values: { type: "array", items: { type: "number" }, description: "Optional set of acceptable values (an enum). Mutually exclusive with min/max." },
        boolean: { type: "boolean", description: "A yes/no switch: the value is 1 (checked) or 0, shown as a checkbox. Use it in expressions, e.g. a pattern count of `1 + showBoth`. Implies values [0, 1]." },
        options: { type: "array", items: { type: "string" }, description: "Named choices (an enum), shown as a dropdown of these names. The value is the chosen index 0…n−1 (the expression sets the default); other parameters use it with pick(), e.g. `pick(material, 0.8, 1.1, 1.4)`. Implies values [0 … n−1]." },
      },
    },
    examples: [
      { params: { name: "width", expression: "60" } },
      { note: "A bounded parameter (slider 20–120)", params: { name: "width", expression: "60", min: 20, max: 120 } },
      { note: "An integer count (slider steps by 1)", params: { name: "stages", expression: "3", min: 1, max: 8, step: 1 } },
      { note: "A pick-list parameter", params: { name: "thread", expression: "3", values: [3, 4, 5, 6, 8] } },
      { note: "A checkbox (1 = checked)", params: { name: "showLid", expression: "1", boolean: true } },
      { note: "Named choices (0 = PLA, 1 = PETG, 2 = TPU), defaulting to PETG", params: { name: "material", expression: "1", options: ["PLA", "PETG", "TPU"] } },
    ],
    apply(draft, p: { name: string; expression: string; min?: number; max?: number; step?: number; values?: number[]; boolean?: boolean; options?: string[] }, ctx) {
      if (draft.parameters.some((x) => x.name === p.name)) throw new Error(`Parameter "${p.name}" exists`);
      if (p.boolean && (p.min != null || p.max != null || p.step != null || p.values)) throw new Error("a boolean parameter takes no extents or value list");
      const options = p.options && checkOptions(p);
      const bounds = normalizeBounds(p.boolean ? { values: [0, 1] } : options ? { values: options.map((_, i) => i) } : p);
      const id = ctx.alloc("param");
      draft.parameters.push({ id, name: p.name, expr: p.expression, value: 0, ...bounds, ...(p.step != null && !bounds.values ? { step: p.step } : {}), ...(p.boolean ? { boolean: true } : {}), ...(options ? { options } : {}) });
      return { createdIds: [id], message: `Added parameter ${p.name}` };
    },
  },
  {
    type: "parameter.setBounds",
    title: "Set parameter extents",
    summary: "Set or clear a parameter's extents (min/max) or its list of acceptable values.",
    description:
      "Sets the optional extents of an existing parameter: `min` and/or `max` for a bounded range, OR `values` for a discrete pick-list — not both. Omit all three (or pass clear:true) to make it unbounded again. A slider/dropdown in the Parameters panel honours these.",
    paramsSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        min: { type: "number" },
        max: { type: "number" },
        step: { type: "number", exclusiveMinimum: 0, description: "Snap increment (1 = integer-only)." },
        values: { type: "array", items: { type: "number" } },
        boolean: { type: "boolean", description: "Make it a yes/no switch (a checkbox): values [0, 1]; a value other than 0 or 1 snaps to 1 if non-zero, else 0." },
        options: { type: "array", items: { type: "string" }, description: "Make it a named choice (a dropdown of these names): values [0 … n−1]; a value that isn't one of them snaps to the nearest." },
        clear: { type: "boolean", description: "Remove all extents / values." },
      },
    },
    examples: [
      { params: { name: "width", min: 20, max: 120 } },
      { note: "Integer-only count", params: { name: "stages", min: 1, max: 8, step: 1 } },
      { note: "Make unbounded", params: { name: "width", clear: true } },
      { note: "Make it a checkbox", params: { name: "showLid", boolean: true } },
      { note: "Make it a named choice", params: { name: "material", options: ["PLA", "PETG", "TPU"] } },
    ],
    apply(draft, p: { name: string; min?: number; max?: number; step?: number; values?: number[]; boolean?: boolean; options?: string[]; clear?: boolean }) {
      const param = draft.parameters.find((x) => x.name === p.name);
      if (!param) throw new Error(`No parameter "${p.name}"`);
      const options = p.options && checkOptions(p);
      delete param.min; delete param.max; delete param.step; delete param.values; delete param.boolean; delete param.options; // new extents replace a checkbox / choice
      if (options) {
        Object.assign(param, { values: options.map((_, i) => i), options });
        const v = resolveParameters(draft.parameters).scope[param.name] ?? 0;
        const k = Math.min(options.length - 1, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));
        if (v !== k) param.expr = String(k);
      } else if (p.boolean) {
        if (p.min != null || p.max != null || p.step != null || p.values) throw new Error("a boolean parameter takes no extents or value list");
        Object.assign(param, { values: [0, 1], boolean: true });
        const v = resolveParameters(draft.parameters).scope[param.name] ?? 0; // param.value is stale until recompute
        if (v !== 0 && v !== 1) param.expr = v !== 0 ? "1" : "0";
      } else if (!p.clear) {
        const bounds = normalizeBounds(p);
        Object.assign(param, bounds);
        if (p.step != null && !bounds.values) param.step = p.step;
      }
      return { message: `Set extents of ${p.name}` };
    },
  },
  {
    type: "parameter.set",
    title: "Set parameter",
    summary: "Change a parameter's expression; the model re-solves.",
    description: "Updates the expression of an existing parameter by name. Triggers a full recompute.",
    paramsSchema: {
      type: "object",
      required: ["name", "expression"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        expression: { type: "string" },
      },
    },
    examples: [{ params: { name: "width", expression: "110" } }],
    apply(draft, p: { name: string; expression: string }) {
      const param = draft.parameters.find((x) => x.name === p.name);
      if (!param) throw new Error(`No parameter "${p.name}"`);
      param.expr = p.expression;
      return { message: `Set ${p.name} = ${p.expression}` };
    },
  },
  {
    type: "parameter.delete",
    title: "Delete parameter",
    summary: "Remove a parameter by name.",
    description: "Removes a parameter. Dimensions referencing it will report an expression error until fixed.",
    paramsSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string" } },
    },
    apply(draft, p: { name: string }) {
      draft.parameters = draft.parameters.filter((x) => x.name !== p.name);
      return { message: `Deleted parameter ${p.name}` };
    },
  },

  // ---- components (assembly tree) ----
  {
    type: "component.create",
    title: "New component",
    summary: "Create a sub-component with its own placement under a parent.",
    description:
      "Creates a child component (a node in the assembly tree) under `parent` (defaults to root), placed at `position` relative to the parent. Sketches and the bodies built on them can be scoped to it (sketch.create {component}); the component's frame composes down the tree. Returns the component id.",
    paramsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        parent: { type: "string", description: "Parent component id. Defaults to the root component." },
        position: {
          type: "object",
          description: "Placement relative to the parent (mm).",
          properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
        name: { type: "string" },
      },
    },
    examples: [{ note: "A component 50mm along X", params: { position: { x: 50, y: 0, z: 0 } } }],
    apply(draft, p: { parent?: string; position?: { x?: number; y?: number; z?: number }; name?: string }, ctx) {
      const parent = p.parent ?? draft.rootComponentId;
      if (!draft.components[parent]) throw new Error(`No parent component "${parent}"`);
      const id = ctx.alloc("cmp");
      const count = Object.keys(draft.components).length; // root is #1
      const pos = p.position ?? {};
      draft.components[id] = {
        id,
        name: p.name ?? `Component ${count}`,
        parentId: parent,
        children: [],
        sketches: [],
        transform: { position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 } },
      };
      draft.components[parent].children.push(id);
      return { createdIds: [id], message: `Created ${draft.components[id].name}` };
    },
  },
  {
    type: "joint.create",
    title: "Joint",
    summary: "Position a component relative to another (rigid / revolute / slider).",
    description:
      "Joins the `moved` component to `base` (default root) so a connector point on each — given in that component's LOCAL coordinates — coincides, then applies the joint motion. `rigid` fixes it; `revolute` leaves free rotation about `axis` (base-local) by `value` degrees; `slider` leaves free translation along `axis` by `value`. `pin-slot` rotates about `axis` but SOLVES the angle so the moved-body point `pin` stays on the slot line (`slotPoint`+`slotDir` in `slotBase`'s frame) — a 1-DOF mechanism constraint, so the kernel finds the angle instead of you supplying trig. `value` is a parametric expression (a seed for pin-slot). " +
      "`flexure` is a compliant hinge: it moves like `revolute` but carries a `flexure` section {length, width, thickness} so its strain, stiffness and stored energy can be computed (a small-length flexural pivot; the hinge material is the moved component's, or `flexure.material`). " +
      "Closed loops (a four-bar): give the undriven joints `solve: true` (their value is found, `value` only seeds it) and close the loop with one more joint that has `closes: true` — it places nothing; its two connectors are made to coincide. Returns the joint id.",
    paramsSchema: {
      type: "object",
      required: ["moved", "baseOrigin", "movedOrigin"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["rigid", "revolute", "slider", "pin-slot", "flexure"], description: "Joint type (default rigid)." },
        solve: { type: "boolean", description: "The value is solved so every closing joint's connectors meet (closed loops); `value` only seeds it." },
        closes: { type: "boolean", description: "Close a loop: place nothing, constrain the two connectors to coincide. `moved` must be placed by another joint." },
        flexure: {
          type: "object",
          required: ["length", "width", "thickness"],
          additionalProperties: false,
          description: "flexure only: the hinge strip (mm). length along the strip, thickness in the bending direction, width along the hinge axis. Each may be a number or an expression in the parameters, e.g. \"hingeT\".",
          properties: { length: { type: ["number", "string"] }, width: { type: ["number", "string"] }, thickness: { type: ["number", "string"] }, material: { type: "string", description: "Hinge material id (default: the moved component's)." } },
        },
        base: { type: "string", description: "Base component id. Defaults to the root (ground)." },
        moved: { type: "string", description: "Component to position." },
        baseOrigin: { type: "object", required: ["x", "y", "z"], description: "Each coordinate a number or an expression in the parameters.", properties: { x: { type: ["number", "string"] }, y: { type: ["number", "string"] }, z: { type: ["number", "string"] } } },
        movedOrigin: { type: "object", required: ["x", "y", "z"], description: "Each coordinate a number or an expression in the parameters.", properties: { x: { type: ["number", "string"] }, y: { type: ["number", "string"] }, z: { type: ["number", "string"] } } },
        axis: { type: "object", description: "Joint axis in base-local coords (default +Z).", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        value: { type: "string", description: "Motion expression: degrees (revolute) or length (slider); a seed for pin-slot." },
        pin: { type: "object", description: "pin-slot: the moved-local point constrained to the slot.", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        slotBase: { type: "string", description: "pin-slot: component whose frame defines the slot (default = base)." },
        slotPoint: { type: "object", description: "pin-slot: a point on the slot line, in slotBase-local coords.", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        slotDir: { type: "object", description: "pin-slot: the slot line direction, in slotBase-local coords.", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "Pin a bracket to the base at its origin", params: { moved: "cmp3", baseOrigin: { x: 40, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 } } },
      { note: "Revolute joint spun 30°", params: { kind: "revolute", moved: "cmp3", baseOrigin: { x: 0, y: 0, z: 20 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, value: "30" } },
    ],
    apply(draft, p: { kind?: "rigid" | "revolute" | "slider" | "pin-slot" | "flexure"; base?: string; moved: string; baseOrigin: ExprVec3; movedOrigin: ExprVec3; axis?: Vec3; value?: string; pin?: Vec3; slotBase?: string; slotPoint?: Vec3; slotDir?: Vec3; solve?: boolean; closes?: boolean; flexure?: { length: number | string; width: number | string; thickness: number | string; material?: string }; name?: string }, ctx) {
      const base = p.base ?? draft.rootComponentId;
      if (!draft.components[base]) throw new Error(`No base component "${base}"`);
      if (!draft.components[p.moved]) throw new Error(`No component "${p.moved}"`);
      if (base === p.moved) throw new Error("a joint needs two different components");
      const kind = p.kind ?? "rigid";
      if (kind === "pin-slot") {
        if (!p.pin || !p.slotPoint || !p.slotDir) throw new Error("pin-slot joint needs pin, slotPoint and slotDir");
        if (p.slotBase && !draft.components[p.slotBase]) throw new Error(`No slotBase component "${p.slotBase}"`);
      }
      if (kind === "flexure" && !p.flexure) throw new Error("flexure joint needs a flexure section {length, width, thickness}");
      if (p.flexure?.material && !draft.materials[p.flexure.material]) throw new Error(`No material "${p.flexure.material}"`);
      // a flexure dimension may be an expression: evaluate it now (and reject it before allocating)
      const scope = resolveParameters(draft.parameters).scope;
      const section = kind === "flexure" ? flexureSection(p.flexure!, scope) : undefined;
      // so may a connector point
      const baseO = exprPoint(p.baseOrigin, scope, "baseOrigin"), movedO = exprPoint(p.movedOrigin, scope, "movedOrigin");
      if (p.closes && p.solve) throw new Error("a closing joint is the constraint; give `solve` to the joints it determines");
      if (p.closes && !Object.values(draft.joints).some((j) => j.moved === p.moved && !j.closes)) throw new Error("a closing joint's moved component must already be placed by another joint");
      const id = ctx.alloc("jnt");
      const count = Object.keys(draft.joints).length + 1;
      const v3 = (q: Vec3) => ({ x: q.x, y: q.y, z: q.z });
      draft.joints[id] = {
        id,
        name: p.name ?? `Joint ${count}`,
        kind,
        base,
        moved: p.moved,
        baseOrigin: baseO.value,
        movedOrigin: movedO.value,
        ...(baseO.exprs || movedO.exprs ? { originExprs: { ...(baseO.exprs ? { base: baseO.exprs } : {}), ...(movedO.exprs ? { moved: movedO.exprs } : {}) } } : {}),
        axis: p.axis ?? { x: 0, y: 0, z: 1 },
        valueExpr: String(p.value ?? "0"),
        valueValue: 0,
        ...(kind === "pin-slot" ? { pin: v3(p.pin!), slotBase: p.slotBase ?? base, slotPoint: v3(p.slotPoint!), slotDir: v3(p.slotDir!) } : {}),
        ...(p.solve ? { solve: true } : {}),
        ...(p.closes ? { closes: true } : {}),
        ...(section ? { flexure: { ...section, ...(p.flexure!.material ? { material: p.flexure!.material } : {}) } } : {}),
      };
      return { createdIds: [id], message: `${draft.joints[id].kind} joint` };
    },
  },
  {
    type: "component.connector",
    title: "Add connector",
    summary: "Add a named attachment frame (joint origin) to a component.",
    description:
      "Adds a named connector point in the component's LOCAL coordinates. Relational joint templates bind to these by name (e.g. a bar's `top`/`bottom`/`center` pins), so a component pattern's joints can chain instance to instance without hard-coded ids.",
    paramsSchema: {
      type: "object",
      required: ["component", "name", "origin"],
      additionalProperties: false,
      properties: {
        component: { type: "string" },
        name: { type: "string", description: "Connector name, unique on this component." },
        origin: { type: "object", required: ["x", "y", "z"], description: "Each coordinate a number or an expression in the parameters (e.g. \"height\").", properties: { x: { type: ["number", "string"] }, y: { type: ["number", "string"] }, z: { type: ["number", "string"] } } },
        axis: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "Optional reference axis (local)." },
      },
    },
    examples: [{ params: { component: "cmp3", name: "top", origin: { x: 60, y: 0, z: 0 } } }, { note: "A connector that follows a parameter", params: { component: "cmp3", name: "lid", origin: { x: 0, y: 0, z: "height" } } }],
    apply(draft, p: { component: string; name: string; origin: { x: number | string; y: number | string; z: number | string }; axis?: Vec3 }) {
      const c = draft.components[p.component];
      if (!c) throw new Error(`No component "${p.component}"`);
      c.connectors = c.connectors ?? {};
      const o = p.origin;
      const parametric = [o.x, o.y, o.z].some((v) => typeof v === "string");
      const scope = resolveParameters(draft.parameters).scope;
      const ev = (v: number | string) => (typeof v === "number" ? v : compileExpr(v).eval(scope));
      const origin = { x: ev(o.x), y: ev(o.y), z: ev(o.z) };
      if (![origin.x, origin.y, origin.z].every(Number.isFinite)) throw new Error("connector origin does not evaluate to a number");
      c.connectors[p.name] = {
        origin,
        ...(parametric ? { originExpr: { x: String(o.x), y: String(o.y), z: String(o.z) } } : {}),
        ...(p.axis ? { axis: { x: p.axis.x, y: p.axis.y, z: p.axis.z } } : {}),
      };
      return { message: `Connector ${p.name} on ${c.name}` };
    },
  },
  {
    type: "assembly.pattern",
    title: "Pattern components (jointed)",
    summary: "Duplicate a component subtree N times, placed by joint templates — a parametric, articulating pattern.",
    description:
      "Creates a component pattern over `source` (a component whose subtree — components, sketches, features — is instanced `count` times, count parametric). Unlike feature.pattern (which fuses rigid geometry), the copies are positioned by joint.template joints, so the mechanism still articulates AND the instance count is a parameter. Add the joint templates next. Returns the pattern id.",
    paramsSchema: {
      type: "object",
      required: ["source", "count"],
      additionalProperties: false,
      properties: {
        source: { type: "string", description: "Component id to instance (its whole subtree)." },
        count: { type: ["integer", "string"], description: "Instance count (>=1), or an expression like \"stages\"." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "Repeat a scissor stage `stages` times", params: { source: "cmp2", count: "stages", name: "Linkages" } }],
    apply(draft, p: { source: string; count: number | string; name?: string }, ctx) {
      if (!draft.components[p.source]) throw new Error(`No source component "${p.source}"`);
      const id = ctx.alloc("apat");
      const parsed = typeof p.count === "number" ? p.count : parseFloat(p.count);
      draft.componentPatterns[id] = { id, name: p.name ?? "Component pattern", source: p.source, countExpr: String(p.count), count: Math.max(1, Math.round(Number.isFinite(parsed) ? parsed : 1)) };
      return { createdIds: [id], message: `Component pattern ×${p.count}` };
    },
  },
  {
    type: "joint.template",
    title: "Joint template",
    summary: "A relational joint for a component pattern, stamped once per instance.",
    description:
      "Adds a joint rule to a pattern. `base`/`moved` are role refs {role: self|prev|root, component, port}; the expander resolves them to concrete instances each rebuild (self → instance i, prev → i-1, root → ground). `appliesTo`: \"first\" (i=0, the grounding/seed joints), \"rest\" (i>=1, the repeating chain), or \"all\". `value` (degrees for revolute, length for slider) may reference the 0-based instance index `i` and parameters; a regular mechanism reuses the same expression every stage.",
    paramsSchema: {
      type: "object",
      required: ["pattern", "base", "moved"],
      additionalProperties: false,
      properties: {
        pattern: { type: "string" },
        kind: { type: "string", enum: ["rigid", "revolute", "slider"] },
        base: ROLE_REF_SCHEMA,
        moved: ROLE_REF_SCHEMA,
        axis: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "Joint axis in base-local coords (default +Z)." },
        value: { type: "string", description: "Motion expression; may use `i` and parameters." },
        appliesTo: { type: "string", enum: ["first", "rest", "all"], description: "Which instances get this joint (default all)." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "Ground + drive the first bar", params: { pattern: "apat1", kind: "revolute", base: { role: "root", origin: { x: 0, y: 0, z: 0 } }, moved: { role: "self", component: "cmp3", port: "bottom" }, axis: { x: 0, y: -1, z: 0 }, value: "theta", appliesTo: "first" } },
      { note: "Chain each bar to the previous stage's top", params: { pattern: "apat1", kind: "revolute", base: { role: "prev", component: "cmp4", port: "top" }, moved: { role: "self", component: "cmp3", port: "bottom" }, axis: { x: 0, y: -1, z: 0 }, value: "2*theta-180", appliesTo: "rest" } },
    ],
    apply(draft, p: { pattern: string; kind?: "rigid" | "revolute" | "slider"; base: RoleRef; moved: RoleRef; axis?: Vec3; value?: string; appliesTo?: "first" | "rest" | "all"; name?: string }, ctx) {
      if (!draft.componentPatterns[p.pattern]) throw new Error(`No pattern "${p.pattern}"`);
      const id = ctx.alloc("jtpl");
      draft.jointTemplates[id] = {
        id, name: p.name ?? "Joint template", patternId: p.pattern, kind: p.kind ?? "revolute",
        base: p.base, moved: p.moved, axis: p.axis ?? { x: 0, y: 0, z: 1 },
        valueExpr: String(p.value ?? "0"), appliesTo: p.appliesTo ?? "all",
      };
      return { createdIds: [id], message: "Joint template" };
    },
  },
  {
    type: "material.create",
    title: "Create material",
    summary: "Define a material (wood / metal / plastic) assignable to components.",
    description:
      "Adds a material to the document's appearance library. kind \"wood\" uses a procedural 3D grain shader driven by `species` (white-oak, red-oak, walnut, maple, hard-maple, cherry, southern-pine, mahogany, beech, ash) with optional ringScale/grainContrast/poreStrength overrides; \"metal\"/\"plastic\"/\"painted\" use PBR (color, roughness, metalness, finish). Assign it with material.assign. Returns the material id.",
    paramsSchema: {
      type: "object",
      required: ["name", "kind"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["wood", "metal", "plastic", "painted"] },
        species: { type: "string", description: "wood species preset key." },
        finish: { type: "string", description: "metal/plastic: polished|brushed|satin|matte|gloss." },
        color: { type: "string", description: "base/tint hex override, e.g. \"#8a6b3f\"." },
        roughness: { type: "number", minimum: 0, maximum: 1 },
        metalness: { type: "number", minimum: 0, maximum: 1 },
        ringScale: { type: "number", exclusiveMinimum: 0, description: "wood: growth-ring spacing (mm)." },
        grainContrast: { type: "number", minimum: 0, maximum: 1 },
        poreStrength: { type: "number", minimum: 0, maximum: 1 },
        youngsModulus: { type: "number", exclusiveMinimum: 0, description: "Mechanical: Young's modulus (MPa), for flexure analysis." },
        allowableStrain: { type: "number", exclusiveMinimum: 0, description: "Mechanical: the peak strain a flexure may see in service (fraction, e.g. 0.08). Needs youngsModulus." },
      },
    },
    examples: [
      { note: "White oak", params: { name: "Oak", kind: "wood", species: "white-oak" } },
      { note: "A flexible print (Bambu TPU for AMS, printed flat)", params: { name: "TPU", kind: "plastic", finish: "matte", youngsModulus: 1190, allowableStrain: 0.08 } },
      { note: "A steel screw", params: { name: "Steel", kind: "metal", finish: "satin", color: "#8a8f96" } },
    ],
    apply(draft, p: { name: string; kind: Material["kind"]; [k: string]: unknown }, ctx) {
      const id = ctx.alloc("mat");
      const m: Material = { id, name: p.name, kind: p.kind };
      for (const k of ["species", "finish", "color", "roughness", "metalness", "ringScale", "grainContrast", "poreStrength"] as const) {
        if (p[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = p[k];
      }
      if ((p.youngsModulus === undefined) !== (p.allowableStrain === undefined)) throw new Error("mechanical properties need both youngsModulus and allowableStrain");
      if (p.youngsModulus !== undefined) m.mechanical = { E: p.youngsModulus as number, allowableStrain: p.allowableStrain as number };
      draft.materials[id] = m;
      return { createdIds: [id], message: `Material ${p.name}` };
    },
  },
  {
    type: "material.assign",
    title: "Assign material",
    summary: "Assign a material to a component (its bodies inherit; root = document default).",
    description: "Sets the material of `component` (defaults to the root component, i.e. the document-wide default). A body uses the nearest ancestor component that has a material. Or, with `materials` + `by`, the component takes materials[value of parameter `by`]: one per choice of a named-choice parameter, so picking the choice switches the material.",
    paramsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        material: { type: "string" },
        component: { type: "string", description: "Target component; defaults to root." },
        materials: { type: "array", items: { type: "string" }, description: "One material per value 0…n−1 of parameter `by` (instead of `material`)." },
        by: { type: "string", description: "The parameter whose value picks from `materials`, e.g. a named choice." },
      },
    },
    examples: [
      { params: { material: "mat5", component: "cmp3" } },
      { note: "Follow a named choice: PLA, PETG or TPU", params: { materials: ["mat5", "mat6", "mat7"], by: "material", component: "cmp3" } },
    ],
    apply(draft, p: { material?: string; materials?: string[]; by?: string; component?: string }) {
      const comp = p.component ?? draft.rootComponentId;
      if (!draft.components[comp]) throw new Error(`No component "${comp}"`);
      if (p.materials || p.by) {
        if (p.material || !p.materials || !p.by) throw new Error("give `materials` with `by` (or a single `material`)");
        for (const m of p.materials) if (!draft.materials[m]) throw new Error(`No material "${m}"`);
        if (!draft.parameters.some((x) => x.name === p.by)) throw new Error(`No parameter "${p.by}"`);
        delete draft.components[comp].materialId;
        draft.components[comp].materialChoice = { by: p.by, materials: [...p.materials] };
        return { message: `Material follows ${p.by}` };
      }
      if (!p.material) throw new Error("give a `material`");
      if (!draft.materials[p.material]) throw new Error(`No material "${p.material}"`);
      delete draft.components[comp].materialChoice;
      draft.components[comp].materialId = p.material;
      return { message: `Assigned ${draft.materials[p.material].name}` };
    },
  },

  // ---- sketch lifecycle ----
  {
    type: "sketch.create",
    title: "Create sketch",
    summary: "Start a new sketch on an origin plane, an offset plane, or a body face.",
    description:
      "Creates a sketch with a fixed origin point. Bind it to an origin plane (`plane`: XY/XZ/YZ), optionally offset along its normal (`offset`), a datum plane (`datum`: a plane.create id), or an arbitrary plane via `planeDef` {origin, normal} (e.g. a picked face). Returns [sketchId, originId].",
    paramsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        plane: { type: "string", enum: PLANE_ENUM, description: "Origin plane." },
        offset: { type: "number", description: "Offset distance along the plane normal." },
        datum: { type: "string", description: "A datum plane id (from plane.create) to sketch on." },
        planeDef: {
          type: "object",
          description: "Arbitrary plane from a face: origin point + normal vector.",
          properties: {
            origin: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
            normal: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          },
        },
        component: { type: "string", description: "Owning component id (from component.create). Defaults to the root component." },
        faceRef: {
          type: "object",
          description: "Parametric body-face reference (with planeDef): the sketch re-resolves to this face each rebuild.",
          properties: {
            normal: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
            point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          },
        },
        name: { type: "string", description: "Optional sketch name." },
      },
    },
    examples: [
      { note: "Sketch on the front plane", params: { plane: "XZ" } },
      { note: "Sketch 20mm above XY", params: { plane: "XY", offset: 20 } },
      { note: "Sketch on a datum plane", params: { datum: "pl5" } },
    ],
    apply(draft, p: { plane?: string; offset?: number; datum?: string; planeDef?: { origin: Vec3; normal: Vec3 }; faceRef?: { normal: Vec3; point: Vec3 }; component?: string; name?: string }, ctx) {
      const sid = ctx.alloc("sketch");
      const originId = ctx.alloc("pt");
      const count = Object.keys(draft.sketches).length + 1;
      const comp = p.component ?? draft.rootComponentId;
      if (!draft.components[comp]) throw new Error(`No component "${comp}"`);
      const origin: SketchPoint = { id: originId, kind: "point", x: 0, y: 0, fixed: true };
      let planeId = p.plane ?? "custom";
      let plane: WorkPlane | undefined;
      let datumId: string | undefined;
      if (p.datum) {
        if (!draft.planes[p.datum]) throw new Error(`No datum plane "${p.datum}"`);
        planeId = "datum";
        datumId = p.datum; // resolved into `plane` by recompute
      } else if (p.planeDef) {
        plane = makePlaneFromNormal(p.planeDef.origin, p.planeDef.normal, p.name);
        planeId = "custom";
      } else if (p.offset && Math.abs(p.offset) > 1e-9) {
        plane = offsetPlane(planeById(p.plane ?? "XY"), p.offset);
        planeId = "custom";
      }
      draft.sketches[sid] = {
        id: sid,
        name: p.name ?? `Sketch ${count}`,
        planeId,
        plane,
        datumId,
        componentId: comp,
        faceRef: p.faceRef,
        originPointId: originId,
        entities: { [originId]: origin },
        constraints: {},
        status: { dof: 0, fullyConstrained: false, converged: true, conflicting: false },
      };
      draft.components[comp].sketches.push(sid);
      return { createdIds: [sid, originId], affectedSketchId: sid, message: `Created ${draft.sketches[sid].name}` };
    },
  },
  {
    type: "plane.create",
    title: "Offset plane",
    summary: "Create a reusable datum plane offset from a base plane.",
    description:
      "Creates a parametric datum/reference plane: offset from a base plane (an origin plane XY/XZ/YZ or another datum plane id) by `offset` along its normal, or through an `origin` point (x/y/z may be parameter expressions) with a `normal` direction — e.g. a plane square to a slanted edge at a point that moves with the model's size. Its in-plane axes follow face sketches: u horizontal when the normal is, v up. Reusable: sketch on it with sketch.create {datum: <id>}; editing the parameters moves everything built on it. Returns the plane id.",
    paramsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base: { type: "string", description: "Offset plane: base plane, XY/XZ/YZ or a datum plane id." },
        offset: { type: "string", description: "Offset plane: distance expression, e.g. '20' or 'height/2'." },
        origin: { type: "object", required: ["x", "y", "z"], description: "Point-and-normal plane: a point on it; each coordinate a number or an expression.", properties: { x: { type: ["number", "string"] }, y: { type: ["number", "string"] }, z: { type: ["number", "string"] } } },
        normal: { type: "object", required: ["x", "y", "z"], description: "Point-and-normal plane: its normal.", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "A plane 25mm above XY", params: { base: "XY", offset: "25" } },
      { note: "A plane square to a 30° edge, at a point that scales with `size`", params: { origin: { x: "size*0.5", y: "size*0.2", z: 0 }, normal: { x: 0.866, y: 0.5, z: 0 } } },
    ],
    apply(draft, p: { base?: string; offset?: string | number; origin?: { x: number | string; y: number | string; z: number | string }; normal?: Vec3; name?: string }, ctx) {
      const name = p.name ?? `Plane ${Object.keys(draft.planes).length + 1}`;
      if (p.origin || p.normal) {
        if (!p.origin || !p.normal) throw new Error("a point-and-normal plane needs both origin and normal");
        if (Math.hypot(p.normal.x, p.normal.y, p.normal.z) < 1e-12) throw new Error("plane normal is zero");
        const scope = resolveParameters(draft.parameters).scope;
        for (const v of [p.origin.x, p.origin.y, p.origin.z]) {
          if (typeof v === "string" && !Number.isFinite(compileExpr(v).eval(scope))) throw new Error(`plane origin "${v}" is not a number`);
        }
        const id = ctx.alloc("pl");
        const o = p.origin;
        draft.planes[id] = { id, name, kind: "frame", base: "", offsetExpr: "0", offsetValue: 0, originExpr: { x: String(o.x), y: String(o.y), z: String(o.z) }, normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z } };
        return { createdIds: [id], message: "Point-and-normal plane" };
      }
      if (p.base === undefined || p.offset === undefined) throw new Error("an offset plane needs base and offset");
      if (!["XY", "XZ", "YZ"].includes(p.base) && !draft.planes[p.base]) throw new Error(`No base plane "${p.base}"`);
      const id = ctx.alloc("pl");
      draft.planes[id] = {
        id,
        name,
        kind: "offset",
        base: p.base,
        offsetExpr: String(p.offset),
        offsetValue: 0,
      };
      return { createdIds: [id], message: `Offset plane from ${p.base}` };
    },
  },

  // ---- geometry ----
  {
    type: "sketch.addPoint",
    title: "Add point",
    summary: "Add a free point to a sketch.",
    description: "Adds a point at (x,y). Set fixed=true to lock it. x/y may be expressions in the parameters (e.g. \"width/2\"): the point is then fixed there and follows the parameters on every rebuild.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "x", "y"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        x: { type: ["number", "string"] },
        y: { type: ["number", "string"] },
        fixed: { type: "boolean" },
      },
    },
    apply(draft, p: { sketch: string; x: number | string; y: number | string; fixed?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const pt = parametricPoint(draft, "", p.x, p.y, p.fixed); // evaluate before allocating
      const id = ctx.alloc("pt");
      sk.entities[id] = { ...pt, id };
      return { createdIds: [id], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.addLine",
    title: "Add line",
    summary: "Add a line between two points (new coordinates or existing-point refs).",
    description:
      "Creates a line. Endpoints may be new {x,y} points or {ref} to existing points; reusing a point id makes the endpoints coincident automatically. Returns [lineId, startId, endId].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "start", "end"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        start: POINT_REF_SCHEMA,
        end: POINT_REF_SCHEMA,
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [
      { note: "From origin to (60,0)", params: { sketch: "sketch1", start: { ref: "pt2" }, end: { x: 60, y: 0 } } },
    ],
    apply(draft, p: { sketch: string; start: PointRef; end: PointRef; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const a = resolvePoint(sk, p.start, ctx, draft);
      const b = resolvePoint(sk, p.end, ctx, draft);
      const id = ctx.alloc("ln");
      sk.entities[id] = { id, kind: "line", p1: a, p2: b, construction: !!p.construction };
      return { createdIds: [id, a, b], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.addCircle",
    title: "Add circle",
    summary: "Add a circle by center and radius.",
    description: "Creates a circle. Center may be a new {x,y} point or {ref}. Returns [circleId, centerId].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "center", "radius"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        center: POINT_REF_SCHEMA,
        radius: { type: "number", minimum: 0 },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    apply(draft, p: { sketch: string; center: PointRef; radius: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const c = resolvePoint(sk, p.center, ctx, draft);
      const id = ctx.alloc("ci");
      sk.entities[id] = { id, kind: "circle", center: c, r: p.radius, construction: !!p.construction };
      return { createdIds: [id, c], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.addEllipse",
    title: "Add ellipse",
    summary: "Add an ellipse by center, radii and rotation.",
    description:
      "Creates an ellipse. Center may be {x,y} or {ref}. `rx`/`ry` are the major/minor radii, `rotation` (radians) rotates it CCW. The center is a solver point (constrainable); the shape is set here and editable in the timeline. Returns [ellipseId, centerId].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "center", "rx", "ry"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        center: POINT_REF_SCHEMA,
        rx: { type: "number", minimum: 0 },
        ry: { type: "number", minimum: 0 },
        rotation: { type: "number" },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    apply(draft, p: { sketch: string; center: PointRef; rx: number; ry: number; rotation?: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const c = resolvePoint(sk, p.center, ctx, draft);
      const id = ctx.alloc("el");
      sk.entities[id] = { id, kind: "ellipse", center: c, rx: p.rx, ry: p.ry, rotation: p.rotation ?? 0, construction: !!p.construction };
      return { createdIds: [id, c], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.addRectangle",
    title: "Add rectangle",
    summary: "Add a rectangle (4 lines) with horizontal/vertical constraints applied.",
    description:
      "Creates a rectangle between two opposite corners, as 4 coincident lines, and applies 2 horizontal + 2 vertical constraints so it stays rectangular. Returns the 4 corner point ids followed by the 4 line ids (bottom, right, top, left); with `cornerRadius` the fillet arcs/points follow.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "corner", "opposite"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        corner: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        opposite: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        construction: CONSTRUCTION_SCHEMA,
        cornerRadius: { type: "number", minimum: 0, description: "Round all four corners with this radius (a rounded rectangle)." },
      },
    },
    apply(
      draft,
      p: { sketch: string; corner: { x: number; y: number }; opposite: { x: number; y: number }; construction?: boolean; cornerRadius?: number },
      ctx
    ) {
      const sk = sketchOf(draft, p.sketch);
      const cn = !!p.construction;
      const mk = (x: number, y: number) => {
        const id = ctx.alloc("pt");
        sk.entities[id] = { id, kind: "point", x, y };
        return id;
      };
      const p00 = mk(p.corner.x, p.corner.y);
      const p10 = mk(p.opposite.x, p.corner.y);
      const p11 = mk(p.opposite.x, p.opposite.y);
      const p01 = mk(p.corner.x, p.opposite.y);
      const line = (a: string, b: string) => {
        const id = ctx.alloc("ln");
        sk.entities[id] = { id, kind: "line", p1: a, p2: b, construction: cn };
        return id;
      };
      const l0 = line(p00, p10);
      const l1 = line(p10, p11);
      const l2 = line(p11, p01);
      const l3 = line(p01, p00);
      const con = (c: GeometricConstraint) => (sk.constraints[c.id] = c);
      con({ id: ctx.alloc("c"), type: "horizontal", a: p00, b: p10 });
      con({ id: ctx.alloc("c"), type: "horizontal", a: p01, b: p11 });
      con({ id: ctx.alloc("c"), type: "vertical", a: p00, b: p01 });
      con({ id: ctx.alloc("c"), type: "vertical", a: p10, b: p11 });
      const created = [p00, p10, p11, p01, l0, l1, l2, l3];
      if (p.cornerRadius && p.cornerRadius > 0) {
        // Round every corner; each blend replaces the corner point with an arc + 2 tangent points.
        for (const [a, b] of [[l0, l1], [l1, l2], [l2, l3], [l3, l0]] as [string, string][]) {
          created.push(...(blendCorner(sk, a, b, p.cornerRadius, ctx, "fillet").createdIds ?? []));
        }
      }
      return { createdIds: created, affectedSketchId: sk.id };
    },
  },

  {
    type: "sketch.addPolyline",
    title: "Polyline",
    summary: "Add a chain of lines through a list of points (optionally closed) — a whole profile in one call.",
    description:
      "Creates consecutive lines through `points` (each {x,y} or {ref}), sharing the corner points so the chain is coincident. `closed` (default true) adds the closing line back to the first point. Returns the line ids followed by the point ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "points"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        points: { type: "array", items: POINT_REF_SCHEMA, description: "At least 2 points (3 for a closed profile)." },
        closed: { type: "boolean", description: "Close the loop (default true)." },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [{ note: "An L-shaped profile", params: { sketch: "sketch1", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 }] } }],
    apply(draft, p: { sketch: string; points: PointRef[]; closed?: boolean; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const closed = p.closed !== false;
      if (p.points.length < (closed ? 3 : 2)) throw new Error(`polyline needs at least ${closed ? 3 : 2} points`);
      const ids = p.points.map((pt) => resolvePoint(sk, pt, ctx, draft));
      const lines: string[] = [];
      const count = closed ? ids.length : ids.length - 1;
      for (let i = 0; i < count; i++) {
        const id = ctx.alloc("ln");
        sk.entities[id] = { id, kind: "line", p1: ids[i], p2: ids[(i + 1) % ids.length], construction: !!p.construction };
        lines.push(id);
      }
      return { createdIds: [...lines, ...ids], affectedSketchId: sk.id, message: `Polyline (${lines.length} lines)` };
    },
  },
  {
    type: "sketch.addProfile",
    title: "Profile (lines + arcs)",
    summary: "Add a closed profile mixing straight and curved (arc) segments in one call — for turned, filleted or organic outlines.",
    description:
      "Builds a chain of edges through `segments`. The FIRST segment is the start point; each later segment adds an edge to its {x,y}: a straight LINE by default, or an ARC when it carries `radius` (the minor arc of that radius, bulging to the left of the segment direction when `ccw`, else right) or `via` (a point the arc passes through — an unambiguous 3-point arc). " +
      "`closed` (default true) closes the loop: if the last point returns to the start it reuses the start (so the last segment, arc or line, is the closing edge); otherwise a straight edge is added back to the start — for a revolve profile that returns to the axis, that closing edge lies on the axis. Corner points are shared so the chain is coincident. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "segments"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        segments: {
          type: "array",
          description: "At least 2; the first is the start point. radius/ccw or via on a segment make its edge an arc.",
          items: {
            type: "object",
            required: ["x", "y"],
            additionalProperties: false,
            properties: {
              x: { type: "number" }, y: { type: "number" },
              radius: { type: "number", description: "Arc of this radius to the point (else a line)." },
              ccw: { type: "boolean", description: "With radius: bulge left of the segment direction (default right)." },
              via: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } }, description: "A point the arc passes through (3-point arc)." },
            },
          },
        },
        closed: { type: "boolean", description: "Close the loop (default true)." },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [
      { note: "A rounded top (dome half-profile) to revolve: axis→rim→arc up→back down the axis", params: { sketch: "sketch1", segments: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10, radius: 10 }] } },
      { note: "A slot-like outline with line and 3-point arc ends", params: { sketch: "sketch1", segments: [{ x: -10, y: -3 }, { x: 10, y: -3 }, { x: 10, y: 3, via: { x: 13, y: 0 } }, { x: -10, y: 3 }, { x: -10, y: -3, via: { x: -13, y: 0 } }], closed: false } },
    ],
    apply(draft, p: { sketch: string; segments: { x: number; y: number; radius?: number; ccw?: boolean; via?: Vec }[]; closed?: boolean; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const segs = p.segments;
      if (!Array.isArray(segs) || segs.length < 2) throw new Error("profile needs at least 2 segments");
      const cons = !!p.construction;
      const created: string[] = [];
      const mkPt = (x: number, y: number): string => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y, construction: cons }; created.push(id); return id; };
      /** Add a line or arc edge from an existing point to an existing point. */
      const addEdge = (fromId: string, from: Vec, toId: string, to: Vec, seg: { radius?: number; ccw?: boolean; via?: Vec } | null): string => {
        if (seg && (seg.radius != null || seg.via != null)) {
          let center: Vec, r: number, ccw: boolean;
          if (seg.via != null) {
            const cc = circumcentre(from, seg.via, to);
            if (!cc) throw new Error("profile arc via-point is collinear with the endpoints");
            center = cc; r = Math.hypot(from.x - cc.x, from.y - cc.y); ccw = signedArea2(from, seg.via, to) > 0;
          } else {
            const res = arcCentreFromRadius(from, to, seg.radius!, !!seg.ccw); center = res.center; r = seg.radius!; ccw = res.ccw;
          }
          const cid = mkPt(center.x, center.y);
          const aid = ctx.alloc("ar");
          sk.entities[aid] = { id: aid, kind: "arc", center: cid, p1: fromId, p2: toId, r, ccw, construction: cons };
          created.push(aid);
          return aid;
        }
        const lid = ctx.alloc("ln");
        sk.entities[lid] = { id: lid, kind: "line", p1: fromId, p2: toId, construction: cons };
        created.push(lid);
        return lid;
      };

      const start = { x: segs[0].x, y: segs[0].y };
      const startId = mkPt(start.x, start.y);
      let prevId = startId, prev = start;
      let lastEdge = ""; let lastToId = startId;
      for (let i = 1; i < segs.length; i++) {
        const to = { x: segs[i].x, y: segs[i].y };
        const toId = mkPt(to.x, to.y);
        lastEdge = addEdge(prevId, prev, toId, to, segs[i]);
        prevId = toId; prev = to; lastToId = toId;
      }
      if (p.closed !== false) {
        const d = Math.hypot(prev.x - start.x, prev.y - start.y);
        if (d <= 1e-7) {
          // Last point is the start: reuse it so the last segment IS the closer.
          const e = sk.entities[lastEdge] as { p2: string };
          e.p2 = startId;
          delete sk.entities[lastToId];
          const k = created.indexOf(lastToId); if (k >= 0) created.splice(k, 1);
        } else {
          addEdge(prevId, prev, startId, start, null); // straight close
        }
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Profile (${created.length} ids)` };
    },
  },
  {
    type: "sketch.addBar",
    title: "Bar",
    summary: "Add a rectangular bar of a given width centred on the segment p1→p2 (a rotated rectangle without the trigonometry).",
    description:
      "Creates a 4-line rectangle whose centreline runs from p1 to p2 with total `width` across it. Perpendicular constraints keep it rectangular. Returns the 4 corner point ids followed by the 4 line ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "p1", "p2", "width"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        p1: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        p2: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        width: { type: "number", minimum: 0 },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [{ note: "A 3mm-wide diagonal brace", params: { sketch: "sketch1", p1: { x: -20, y: 10 }, p2: { x: 20, y: 50 }, width: 3 } }],
    apply(draft, p: { sketch: string; p1: Vec; p2: Vec; width: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const d = norm2({ x: p.p2.x - p.p1.x, y: p.p2.y - p.p1.y });
      const nx = -d.y * p.width / 2, ny = d.x * p.width / 2;
      const mk = (x: number, y: number) => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y }; return id; };
      const c0 = mk(p.p1.x + nx, p.p1.y + ny), c1 = mk(p.p2.x + nx, p.p2.y + ny), c2 = mk(p.p2.x - nx, p.p2.y - ny), c3 = mk(p.p1.x - nx, p.p1.y - ny);
      const ln = (a: string, b: string) => { const id = ctx.alloc("ln"); sk.entities[id] = { id, kind: "line", p1: a, p2: b, construction: !!p.construction }; return id; };
      const e0 = ln(c0, c1), e1 = ln(c1, c2), e2 = ln(c2, c3), e3 = ln(c3, c0);
      const addP = (l1: string, l2: string) => { const id = ctx.alloc("c"); sk.constraints[id] = { id, type: "perpendicular", l1, l2 }; };
      addP(e0, e1); addP(e1, e2); addP(e2, e3);
      return { createdIds: [c0, c1, c2, c3, e0, e1, e2, e3], affectedSketchId: sk.id, message: "Bar" };
    },
  },
  {
    type: "sketch.addRing",
    title: "Ring",
    summary: "Add two concentric circles (an annulus region — extrude it for a tube, hoop or flange).",
    description:
      "Creates an outer and an inner circle sharing one centre point, so the region between them extrudes as a ring. Returns [outerCircleId, innerCircleId, centerId].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "center", "outerRadius", "innerRadius"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        center: POINT_REF_SCHEMA,
        outerRadius: { type: "number", minimum: 0 },
        innerRadius: { type: "number", minimum: 0 },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [{ note: "A pipe wall", params: { sketch: "sketch1", center: { x: 0, y: 0 }, outerRadius: 15, innerRadius: 12 } }],
    apply(draft, p: { sketch: string; center: PointRef; outerRadius: number; innerRadius: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      if (!(p.innerRadius < p.outerRadius)) throw new Error("innerRadius must be smaller than outerRadius");
      const c = resolvePoint(sk, p.center, ctx, draft);
      const outer = ctx.alloc("ci"); sk.entities[outer] = { id: outer, kind: "circle", center: c, r: p.outerRadius, construction: !!p.construction };
      const inner = ctx.alloc("ci"); sk.entities[inner] = { id: inner, kind: "circle", center: c, r: p.innerRadius, construction: !!p.construction };
      return { createdIds: [outer, inner, c], affectedSketchId: sk.id, message: "Ring" };
    },
  },
  {
    type: "sketch.addSpline",
    title: "Spline",
    summary: "Add a smooth curve through a list of points (an interpolating cubic spline).",
    description:
      "Creates a C1 cubic spline passing through `points` in order (each {x,y} or {ref}); the first and last are its ends and join lines/arcs/other splines into closed profiles. Use it for free-form flanks, cams, airfoils, involutes. Returns [splineId, ...pointIds].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "points"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        points: { type: "array", items: POINT_REF_SCHEMA, description: "At least 2 through-points, in order." },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [{ note: "A gentle S-curve", params: { sketch: "sketch1", points: [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 2 }, { x: 30, y: 10 }] } }],
    apply(draft, p: { sketch: string; points: PointRef[]; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      if (p.points.length < 2) throw new Error("a spline needs at least 2 points");
      const ids = p.points.map((pt) => resolvePoint(sk, pt, ctx, draft));
      // Interior through-points are part of the curve, not standalone nodes.
      for (const id of ids.slice(1, -1)) (sk.entities[id] as SketchPoint).implicit = true;
      const id = ctx.alloc("sp");
      sk.entities[id] = { id, kind: "spline", points: ids, construction: !!p.construction };
      return { createdIds: [id, ...ids], affectedSketchId: sk.id, message: `Spline through ${ids.length} points` };
    },
  },
  {
    type: "sketch.addGear",
    title: "Involute gear",
    summary: "Add an involute gear profile — external spur gear, internal ring gear, or rack — generated the way it is cut, ready to extrude.",
    description:
      "Generates a closed involute gear profile. `type`: \"external\" (default) spur gear, \"internal\" ring gear (toothed bore + rim circle: extrude the annulus), or \"rack\" (straight-flank basic rack, the exact conjugate of the involute). " +
      "Standard proportions: pitch diameter = module × teeth (rack pitch = π·module), `pressureAngle` 20°, addendum 1 and dedendum 1.25 × module, optional `backlash`. " +
      "Flanks are true involutes (interpolating splines). External root fillets are the trochoid swept by the generating rack's rounded tip (`rootFillet` × module, 0.38 standard; 0 = sharp) — small tooth counts get the real undercut. Racks get tangent root fillets. Reference circles (pitch/base/tip/root) are added as construction geometry. " +
      "Geometry is centred at `center` (gear axis, or the rack's pitch-line midpoint with teeth pointing +v); `rotation` turns it (degrees). To mesh two external gears put centres module×(N1+N2)/2 apart and turn one by 180/N degrees; a rack meshes with a gear whose centre sits at (0, pitch radius) above it. " +
      "Add a bore with a circle in the same sketch (nested loop = hole). Returns [centerId, ...curveIds]; the message lists the radii.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "module", "teeth"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        type: { type: "string", enum: ["external", "internal", "rack"], description: "Spur gear (default), ring gear, or rack." },
        center: POINT_REF_SCHEMA,
        module: { type: "number", minimum: 0, description: "Module in mm (tooth size)." },
        teeth: { type: "integer", minimum: 3, description: "Tooth count (rack: teeth along its length)." },
        pressureAngle: { type: "number", description: "Degrees; 20 standard, 14.5 legacy." },
        addendum: { type: "number", description: "× module (default 1)." },
        dedendum: { type: "number", description: "× module (default 1.25)." },
        backlash: { type: "number", description: "Tooth thinning at the pitch circle/line, mm (default 0)." },
        rootFillet: { type: "number", description: "Cutter tip radius × module (default 0.38; 0 = sharp root)." },
        rimThickness: { type: "number", description: "internal: rim outside the root circle, × module (default 3)." },
        rackHeight: { type: "number", description: "rack: body depth below the root line, mm (default 2 × module)." },
        samples: { type: "integer", minimum: 3, description: "Through-points per flank/fillet spline (default 8)." },
        rotation: { type: "number", description: "Rotate the profile by this angle in degrees." },
        referenceCircles: { type: "boolean", description: "Add construction circles for pitch/base/tip/root (default true)." },
      },
    },
    examples: [
      { note: "A 20-tooth module-2 spur gear at the origin", params: { sketch: "sketch1", module: 2, teeth: 20 } },
      { note: "A 12-tooth pinion meshing with it: centre distance 2·(20+12)/2 = 32, turned half a tooth", params: { sketch: "sketch1", center: { x: 32, y: 0 }, module: 2, teeth: 12, rotation: 15 } },
      { note: "A 10-tooth rack below a gear of pitch radius 20 (gear centre at v=20)", params: { sketch: "sketch1", type: "rack", module: 2, teeth: 10 } },
      { note: "A 40-tooth ring gear", params: { sketch: "sketch1", type: "internal", module: 2, teeth: 40 } },
    ],
    apply(draft, p: { sketch: string; type?: GearType; center?: PointRef; module: number; teeth: number; pressureAngle?: number; addendum?: number; dedendum?: number; backlash?: number; rootFillet?: number; rimThickness?: number; rackHeight?: number; samples?: number; rotation?: number; referenceCircles?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const g = gearOutline({ type: p.type, module: p.module, teeth: p.teeth, pressureAngle: p.pressureAngle, addendum: p.addendum, dedendum: p.dedendum, backlash: p.backlash, rootFillet: p.rootFillet, rimThickness: p.rimThickness, rackHeight: p.rackHeight, samples: p.samples });
      const cId = resolvePoint(sk, p.center ?? { x: 0, y: 0 }, ctx);
      const C = sk.entities[cId] as SketchPoint;
      const rot = ((p.rotation ?? 0) * Math.PI) / 180;
      const place = (q: Vec): Vec => ({ x: C.x + q.x * Math.cos(rot) - q.y * Math.sin(rot), y: C.y + q.x * Math.sin(rot) + q.y * Math.cos(rot) });
      // Generated profile points are fixed: the gear is edited through its parameters (edit_operation),
      // and a thousand free points would only burden the constraint solver.
      const mk = (q: Vec, implicit = true) => { const id = ctx.alloc("pt"); const w = place(q); sk.entities[id] = { id, kind: "point", x: w.x, y: w.y, implicit, fixed: true }; return id; };
      const curves: string[] = [];
      // Walk the outline, sharing every junction point so each joint is coincident; close back onto the start.
      const startId = mk(g.start, false);
      let cur = startId;
      const pendingFillets: { point: string; r: number }[] = [];
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        const isLast = i === g.edges.length - 1;
        if (e.kind === "spline") {
          const ids = [cur, ...e.through.map((q, k) => (isLast && k === e.through.length - 1 ? startId : mk(q)))];
          const id = ctx.alloc("sp"); sk.entities[id] = { id, kind: "spline", points: ids }; curves.push(id);
          cur = ids[ids.length - 1];
        } else {
          const to = isLast ? startId : mk(e.to);
          if (e.kind === "line") {
            const id = ctx.alloc("ln"); sk.entities[id] = { id, kind: "line", p1: cur, p2: to }; curves.push(id);
            if (e.filletAtEnd) pendingFillets.push({ point: to, r: e.filletAtEnd });
          } else {
            const id = ctx.alloc("ar"); sk.entities[id] = { id, kind: "arc", center: cId, p1: cur, p2: to, r: e.r, ccw: e.ccw }; curves.push(id);
          }
          cur = to;
        }
      }
      for (const f of pendingFillets) {
        const ls = linesAt(sk, f.point);
        if (ls.length === 2) curves.push(...(blendCorner(sk, ls[0], ls[1], f.r, ctx, "fillet").createdIds ?? []));
      }
      for (const c of g.circles) {
        const id = ctx.alloc("ci"); sk.entities[id] = { id, kind: "circle", center: cId, r: c.r }; curves.push(id);
      }
      if (p.referenceCircles !== false) {
        for (const c of g.reference) {
          const id = ctx.alloc("ci"); sk.entities[id] = { id, kind: "circle", center: cId, r: c.r, construction: true };
        }
      }
      return { createdIds: [cId, ...curves], affectedSketchId: sk.id, message: g.summary };
    },
  },
  {
    type: "sketch.addPolygon",
    title: "Add polygon",
    summary: "Add a regular N-sided polygon inscribed in a circle.",
    description:
      "Creates a regular polygon with `sides` edges, centered at `center`, with one vertex at `vertex` (sets size + rotation). Adds a construction circle through the vertices (point-on-circle) and equal-length edges so it stays regular. Returns the created line ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "center", "vertex", "sides"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        center: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        vertex: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        sides: { type: "integer", minimum: 3, maximum: 64 },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [{ note: "Hexagon", params: { sketch: "sketch1", center: { x: 0, y: 0 }, vertex: { x: 20, y: 0 }, sides: 6 } }],
    apply(draft, p: { sketch: string; center: Vec; vertex: Vec; sides: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const R = Math.hypot(p.vertex.x - p.center.x, p.vertex.y - p.center.y);
      if (R < 1e-6) throw new Error("polygon radius is zero");
      const base = Math.atan2(p.vertex.y - p.center.y, p.vertex.x - p.center.x);
      const N = p.sides;
      const centerId = ctx.alloc("pt");
      sk.entities[centerId] = { id: centerId, kind: "point", x: p.center.x, y: p.center.y };
      const circleId = ctx.alloc("ci");
      sk.entities[circleId] = { id: circleId, kind: "circle", center: centerId, r: R, construction: true };
      const verts: string[] = [];
      for (let i = 0; i < N; i++) {
        const a = base + (i * 2 * Math.PI) / N;
        const id = ctx.alloc("pt");
        sk.entities[id] = { id, kind: "point", x: p.center.x + R * Math.cos(a), y: p.center.y + R * Math.sin(a) };
        verts.push(id);
      }
      const lines: string[] = [];
      for (let i = 0; i < N; i++) {
        const id = ctx.alloc("ln");
        sk.entities[id] = { id, kind: "line", p1: verts[i], p2: verts[(i + 1) % N], construction: !!p.construction };
        lines.push(id);
      }
      const con = (c: GeometricConstraint) => (sk.constraints[c.id] = c);
      for (const vid of verts) con({ id: ctx.alloc("c"), type: "pointOnCircle", point: vid, circle: circleId });
      for (let i = 0; i < N - 1; i++) con({ id: ctx.alloc("c"), type: "equal", e1: lines[i], e2: lines[i + 1] });
      return { createdIds: [circleId, ...verts, ...lines], affectedSketchId: sk.id, message: `${N}-gon` };
    },
  },
  {
    type: "sketch.projectCurves",
    title: "Project",
    summary: "Create sketch geometry from projected body edges.",
    description:
      "Materializes a list of 2D curves (as produced by projecting a body's edges onto this sketch's plane) into sketch entities. Each curve is line {a,b}, circle {cx,cy,r}, arc {cx,cy,r,a,b,ccw}, or poly {pts}. Set `construction` to make them reference geometry. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "curves"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        curves: { type: "array" },
        construction: { type: "boolean" },
      },
    },
    apply(draft, p: { sketch: string; curves: ProjectedCurve[]; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const cn = !!p.construction;
      const mk = (x: number, y: number): string => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y, construction: cn }; return id; };
      const created: string[] = [];
      for (const c of p.curves) {
        if (c.kind === "line") {
          const a = mk(c.a.x, c.a.y), b = mk(c.b.x, c.b.y), id = ctx.alloc("ln");
          sk.entities[id] = { id, kind: "line", p1: a, p2: b, construction: cn };
          created.push(id);
        } else if (c.kind === "circle") {
          const ctr = mk(c.cx, c.cy), id = ctx.alloc("ci");
          sk.entities[id] = { id, kind: "circle", center: ctr, r: c.r, construction: cn };
          created.push(id);
        } else if (c.kind === "arc") {
          const ctr = mk(c.cx, c.cy), a = mk(c.a.x, c.a.y), b = mk(c.b.x, c.b.y), id = ctx.alloc("ar");
          sk.entities[id] = { id, kind: "arc", center: ctr, p1: a, p2: b, r: c.r, ccw: c.ccw, construction: cn };
          created.push(id);
        } else if (c.kind === "poly") {
          let prev = c.pts.length ? mk(c.pts[0].x, c.pts[0].y) : null;
          for (let i = 1; i < c.pts.length; i++) {
            const next = mk(c.pts[i].x, c.pts[i].y), id = ctx.alloc("ln");
            sk.entities[id] = { id, kind: "line", p1: prev!, p2: next, construction: cn };
            created.push(id);
            prev = next;
          }
        }
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Projected ${p.curves.length} curve${p.curves.length === 1 ? "" : "s"}` };
    },
  },
  {
    type: "sketch.addRectangle3",
    title: "Add rectangle (3-point)",
    summary: "Add a rotated rectangle from a base edge and a width point.",
    description:
      "Creates a rectangle: p1→p2 is one edge; p3 sets the perpendicular width. Adds perpendicular constraints so it stays rectangular. Returns the 4 corner point ids followed by the 4 line ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "p1", "p2", "p3"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        p1: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        p2: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        p3: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    apply(draft, p: { sketch: string; p1: Vec; p2: Vec; p3: Vec; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const cn = !!p.construction;
      let dx = p.p2.x - p.p1.x, dy = p.p2.y - p.p1.y;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const px = -dy, py = dx; // perpendicular
      const w = (p.p3.x - p.p2.x) * px + (p.p3.y - p.p2.y) * py;
      const mk = (x: number, y: number) => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y }; return id; };
      const c0 = mk(p.p1.x, p.p1.y);
      const c1 = mk(p.p2.x, p.p2.y);
      const c2 = mk(p.p2.x + px * w, p.p2.y + py * w);
      const c3 = mk(p.p1.x + px * w, p.p1.y + py * w);
      const ln = (a: string, b: string) => { const id = ctx.alloc("ln"); sk.entities[id] = { id, kind: "line", p1: a, p2: b, construction: cn }; return id; };
      const e0 = ln(c0, c1), e1 = ln(c1, c2), e2 = ln(c2, c3), e3 = ln(c3, c0);
      const addP = (l1: string, l2: string) => { const id = ctx.alloc("c"); sk.constraints[id] = { id, type: "perpendicular", l1, l2 }; };
      addP(e0, e1); addP(e1, e2); addP(e2, e3);
      return { createdIds: [c0, c1, c2, c3, e0, e1, e2, e3], affectedSketchId: sk.id, message: "Rectangle" };
    },
  },
  {
    type: "sketch.addSlot",
    title: "Add slot",
    summary: "Add a straight slot (two parallel lines capped by semicircular arcs).",
    description:
      "Creates a slot whose arc centers are at p1 and p2, with the given `width` (arc diameter). Adds equal-radius + parallel constraints. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "p1", "p2", "width"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        p1: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        p2: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        width: { type: "number", minimum: 0 },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    apply(draft, p: { sketch: string; p1: Vec; p2: Vec; width: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const cn = !!p.construction;
      let dx = p.p2.x - p.p1.x, dy = p.p2.y - p.p1.y;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const px = -dy, py = dx; // 90° ccw → "left"
      const r = p.width / 2;
      const mk = (x: number, y: number, c = false) => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y, construction: c }; return id; };
      const P1 = mk(p.p1.x, p.p1.y, true), P2 = mk(p.p2.x, p.p2.y, true);
      const A = mk(p.p1.x - px * r, p.p1.y - py * r); // bottom-left
      const B = mk(p.p2.x - px * r, p.p2.y - py * r); // bottom-right
      const C = mk(p.p2.x + px * r, p.p2.y + py * r); // top-right
      const D = mk(p.p1.x + px * r, p.p1.y + py * r); // top-left
      const lnAB = ctx.alloc("ln"); sk.entities[lnAB] = { id: lnAB, kind: "line", p1: A, p2: B, construction: cn };
      const lnCD = ctx.alloc("ln"); sk.entities[lnCD] = { id: lnCD, kind: "line", p1: C, p2: D, construction: cn };
      const arcR = ctx.alloc("ar"); sk.entities[arcR] = { id: arcR, kind: "arc", center: P2, p1: B, p2: C, r, ccw: true, construction: cn };
      const arcL = ctx.alloc("ar"); sk.entities[arcL] = { id: arcL, kind: "arc", center: P1, p1: D, p2: A, r, ccw: true, construction: cn };
      const con = (c: GeometricConstraint) => (sk.constraints[c.id] = c);
      con({ id: ctx.alloc("c"), type: "equal", e1: arcL, e2: arcR });
      con({ id: ctx.alloc("c"), type: "parallel", l1: lnAB, l2: lnCD });
      return { createdIds: [lnAB, lnCD, arcL, arcR, P1, P2], affectedSketchId: sk.id, message: "Slot" };
    },
  },
  {
    type: "sketch.addArc",
    title: "Add arc",
    summary: "Add a circular arc by center, start and end points.",
    description:
      "Creates an arc. center/start/end may be new {x,y} points or {ref}. The radius is taken from center→start. `ccw` sets sweep direction (default true). Returns [arcId, centerId, startId, endId].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "center", "start", "end"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        center: POINT_REF_SCHEMA,
        start: POINT_REF_SCHEMA,
        end: POINT_REF_SCHEMA,
        ccw: { type: "boolean" },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    apply(draft, p: { sketch: string; center: PointRef; start: PointRef; end: PointRef; ccw?: boolean; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const c = resolvePoint(sk, p.center, ctx, draft);
      const s = resolvePoint(sk, p.start, ctx, draft);
      const e = resolvePoint(sk, p.end, ctx, draft);
      const cp = sk.entities[c] as SketchPoint;
      const sp = sk.entities[s] as SketchPoint;
      const r = Math.hypot(sp.x - cp.x, sp.y - cp.y);
      const id = ctx.alloc("ar");
      sk.entities[id] = { id, kind: "arc", center: c, p1: s, p2: e, r, ccw: p.ccw ?? true, construction: !!p.construction };
      return { createdIds: [id, c, s, e], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.moveGeometry",
    title: "Move geometry",
    summary: "Set seed coordinates for points (used to persist a drag).",
    description:
      "Overrides the seed position of one or more points. Replayed after the points are created, so it repositions under-constrained geometry; fully-constrained points are unaffected (the solver overrides). This is how a drag is committed as a single undoable step.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "seeds"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        seeds: {
          type: "object",
          description: "Map of pointId -> {x, y}.",
        },
      },
    },
    apply(draft, p: { sketch: string; seeds: Record<string, { x: number; y: number }> }) {
      const sk = sketchOf(draft, p.sketch);
      for (const [pid, pos] of Object.entries(p.seeds)) {
        const e = sk.entities[pid];
        if (e && e.kind === "point" && !(e as SketchPoint).fixed) {
          (e as SketchPoint).x = pos.x;
          (e as SketchPoint).y = pos.y;
        }
      }
      return { affectedSketchId: sk.id, message: `Moved ${Object.keys(p.seeds).length} point(s)` };
    },
  },

  // ---- constraints & dimensions ----
  {
    type: "sketch.addConstraint",
    title: "Add geometric constraint",
    summary: "Apply a geometric constraint (coincident, horizontal, parallel, …) to entities.",
    description:
      "Adds one geometric constraint. Provide `type` plus the reference fields it needs: " +
      "coincident/horizontal/vertical {a,b} points; parallel/perpendicular {l1,l2} lines; " +
      "equal {e1,e2}; pointOnLine {point,line}; pointOnCircle {point,circle}; midpoint {point,line}; concentric {c1,c2}; " +
      "tangent {a,b}; symmetric {a,b,line}; fix {point}. Rejected (by default) if it over-constrains.",
    constrains: true,
    paramsSchema: {
      type: "object",
      required: ["sketch", "type"],
      properties: {
        sketch: { type: "string" },
        type: {
          type: "string",
          enum: [
            "coincident", "horizontal", "vertical", "parallel", "perpendicular", "collinear",
            "equal", "pointOnLine", "pointOnCircle", "midpoint", "concentric", "tangent", "symmetric", "fix",
          ],
        },
        a: { type: "string" }, b: { type: "string" },
        l1: { type: "string" }, l2: { type: "string" },
        e1: { type: "string" }, e2: { type: "string" },
        c1: { type: "string" }, c2: { type: "string" },
        point: { type: "string" }, line: { type: "string" }, circle: { type: "string" },
      },
    },
    examples: [
      { note: "Make two points coincident", params: { sketch: "sketch1", type: "coincident", a: "pt3", b: "pt7" } },
      { note: "Make a line horizontal", params: { sketch: "sketch1", type: "horizontal", a: "pt3", b: "pt4" } },
    ],
    apply(draft, p: any, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const id = ctx.alloc("c");
      const { sketch, ...rest } = p;
      void sketch;
      sk.constraints[id] = { id, ...rest } as GeometricConstraint;
      return { createdIds: [id], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.addDimension",
    title: "Add dimension",
    summary: "Apply a parametric dimension (distance, radius, angle, …).",
    description:
      "Adds a dimensional constraint driven by an expression. Provide `type`, the reference fields, and `expression`: " +
      "distance/distanceX/distanceY {a,b}; radius/diameter {circle}; angle {l1,l2}; pointLineDistance {point,line}. " +
      "The expression may reference parameters. Angles are in radians (use rad(30) for degrees). " +
      "Rejected (by default) if it over-constrains.",
    constrains: true,
    paramsSchema: {
      type: "object",
      required: ["sketch", "type", "expression"],
      properties: {
        sketch: { type: "string" },
        type: {
          type: "string",
          enum: ["distance", "distanceX", "distanceY", "radius", "diameter", "angle", "pointLineDistance"],
        },
        expression: { type: "string" },
        driven: { type: "boolean", description: "Reference dimension: measures without constraining." },
        label: { type: "object", description: "Annotation offset position in sketch (u,v).", properties: { x: { type: "number" }, y: { type: "number" } } },
        a: { type: "string" }, b: { type: "string" },
        circle: { type: "string" }, point: { type: "string" }, line: { type: "string" },
        l1: { type: "string" }, l2: { type: "string" },
      },
    },
    examples: [
      { note: "Drive width with a parameter", params: { sketch: "sketch1", type: "distanceX", a: "pt2", b: "pt3", expression: "width" } },
      { note: "Set a radius", params: { sketch: "sketch1", type: "radius", circle: "ci5", expression: "9" } },
    ],
    apply(draft, p: any, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const id = ctx.alloc("d");
      const { sketch, expression, ...rest } = p;
      void sketch;
      sk.constraints[id] = { id, value: 0, expr: expression, ...rest } as DimensionConstraint;
      return { createdIds: [id], affectedSketchId: sk.id };
    },
  },
  // ---- features (3D) ----
  {
    type: "feature.extrude",
    title: "Extrude",
    summary: "Extrude a sketch region into a solid (optionally joined/cut with existing bodies).",
    description:
      "Creates an extruded solid from a sketch along its plane normal. `distance` is an expression (parametric), e.g. \"10\" or \"height*2\". " +
      "A sketch is split into closed regions (disjoint boundaries are separate regions; nested loops are holes). " +
      "Omit `region` to extrude every region; pass `region` {x,y} (a point inside one region, in sketch u,v) to extrude just that one. " +
      "`operation` combines the result with existing bodies, Fusion-style: \"new\" (default) makes a separate body, \"join\" fuses it into the most recent body, \"cut\" subtracts it. " +
      "`direction` \"reverse\" extrudes against the sketch normal (into a body when sketching on its face). `extent` \"throughAll\" ignores `distance` and goes past every existing body (with `symmetric`, both ways) — the right choice for through-holes. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        distance: { type: "string", description: "Distance expression, e.g. '10' or 'height*2'." },
        symmetric: { type: "boolean", description: "Extrude symmetrically about the plane." },
        direction: { type: "string", enum: ["normal", "reverse"], description: "Along the sketch normal (default) or against it." },
        extent: { type: "string", enum: ["blind", "throughAll"], description: "blind (default): `distance`. throughAll: past every existing body." },
        operation: { type: "string", enum: ["new", "join", "cut", "intersect"], description: "Combine with existing bodies: new (default), join, or cut." },
        region: {
          type: "object",
          description: "A point inside the region to extrude (sketch u,v). Omit to extrude every region.",
          required: ["x", "y"],
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        body: { type: "string", description: "Target body (feature id) for join/cut/intersect; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a join/cut that changes nothing an error, not a warning." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "Extrude sketch1 by the `height` parameter", params: { sketch: "sketch1", distance: "height" } },
      { note: "Join a boss onto the current body", params: { sketch: "sketch3", distance: "6", operation: "join" } },
      { note: "A through-hole from a face sketch", params: { sketch: "sketch4", distance: "0", operation: "cut", direction: "reverse", extent: "throughAll" } },
    ],
    apply(draft, p: { sketch: string; distance: string | number; symmetric?: boolean; direction?: "normal" | "reverse"; extent?: "blind" | "throughAll"; operation?: "new" | "join" | "cut" | "intersect"; region?: { x: number; y: number }; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      if (!draft.sketches[p.sketch]) throw new Error(`No sketch "${p.sketch}"`);
      const id = ctx.alloc("ext");
      draft.features[id] = {
        id,
        kind: "extrude",
        name: p.name ?? "Extrude",
        sketchId: p.sketch,
        distanceExpr: String(p.distance),
        distanceValue: 0,
        symmetric: !!p.symmetric,
        ...(p.direction === "reverse" ? { direction: "reverse" as const } : {}),
        ...(p.extent === "throughAll" ? { extent: "throughAll" as const } : {}),
        operation: p.operation ?? "new",
        regionPoint: p.region,
        ...(p.body ? { body: p.body } : {}),
        ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: `Extrude ${p.sketch}` };
    },
  },
  {
    type: "feature.revolve",
    title: "Revolve",
    summary: "Revolve a sketch region about an axis in its plane into a solid (cylinders, domes, hoops, turned parts in one feature).",
    description:
      "Revolves the sketch's closed region(s) about the line through `axis.p1`→`axis.p2` (sketch u,v coordinates; e.g. the v axis is {p1:{x:0,y:0},p2:{x:0,y:1}}) by `angle` degrees (expression; default 360). The profile must lie on one side of the axis. `operation` and `region` behave as in feature.extrude. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "axis"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        axis: {
          type: "object",
          required: ["p1", "p2"],
          description: "Axis through two sketch points (u,v).",
          properties: {
            p1: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
            p2: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
          },
        },
        angle: { type: "string", description: "Sweep angle in degrees (expression). Default 360." },
        operation: { type: "string", enum: ["new", "join", "cut", "intersect"] },
        region: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        body: { type: "string", description: "Target body (feature id) for join/cut/intersect; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a join/cut that changes nothing an error." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "A drum from its half profile sketched on XZ, revolved about the sketch v (world Z) axis", params: { sketch: "sketch2", axis: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 } } } },
      { note: "A quarter-turn boss joined to the body", params: { sketch: "sketch5", axis: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }, angle: "90", operation: "join" } },
    ],
    apply(draft, p: { sketch: string; axis: { p1: Vec; p2: Vec }; angle?: string | number; operation?: "new" | "join" | "cut" | "intersect"; region?: Vec; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      if (!draft.sketches[p.sketch]) throw new Error(`No sketch "${p.sketch}"`);
      const id = ctx.alloc("rev");
      draft.features[id] = {
        id, kind: "revolve", name: p.name ?? "Revolve", sketchId: p.sketch, axis: p.axis,
        angleExpr: String(p.angle ?? 360), angleValue: 360, operation: p.operation ?? "new", regionPoint: p.region,
        ...(p.body ? { body: p.body } : {}), ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: `Revolve ${p.sketch}` };
    },
  },
  {
    type: "feature.primitive",
    title: "Primitive solid",
    summary: "Create a box / cylinder / cone / sphere / torus directly, in one step — no sketch needed.",
    description:
      "Builds a primitive solid centred on `at` (world mm; default origin): a box/sphere is centred on it, a cylinder/cone is centred on its axis at mid-height (axis = world Z), a torus lies in the XY plane through it. " +
      "Dimensions are expressions (parametric). Required dims by shape — box: x,y,z; cylinder: radius,height; cone: radius,height (plus optional radius2 for a frustum, default 0 = a point); sphere: radius; torus: radius (ring centreline) and tube. " +
      "`operation` combines with an existing body Fusion-style (new/join/cut/intersect); `body` picks which body (its creating-feature id; default the most recent); `requireEffect` makes a cut/join that changes nothing an error. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["shape"],
      additionalProperties: false,
      properties: {
        shape: { type: "string", enum: ["box", "cylinder", "cone", "sphere", "torus"] },
        x: { type: ["string", "number"], description: "box X length (expr)." },
        y: { type: ["string", "number"], description: "box Y length (expr)." },
        z: { type: ["string", "number"], description: "box Z length (expr)." },
        radius: { type: ["string", "number"], description: "cylinder/cone/sphere radius, or torus ring radius (expr)." },
        radius2: { type: ["string", "number"], description: "cone far-end radius (expr; default 0)." },
        height: { type: ["string", "number"], description: "cylinder/cone height (expr)." },
        tube: { type: ["string", "number"], description: "torus tube radius (expr)." },
        at: { type: "object", additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "World centre (default origin)." },
        operation: { type: "string", enum: ["new", "join", "cut", "intersect"] },
        body: { type: "string", description: "Target body (feature id) for join/cut; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a cut/join that changes nothing an error." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "A 40×40×20 box on the ground (centre lifted to z=10)", params: { shape: "box", x: "40", y: "40", z: "20", at: { x: 0, y: 0, z: 10 } } },
      { note: "A Ø16×50 cylinder", params: { shape: "cylinder", radius: "8", height: "50" } },
      { note: "Drill a Ø6 hole through the current body", params: { shape: "cylinder", radius: "3", height: "100", operation: "cut" } },
      { note: "A cone frustum", params: { shape: "cone", radius: "10", radius2: "4", height: "20" } },
    ],
    apply(draft, p: { shape: "box" | "cylinder" | "cone" | "sphere" | "torus"; at?: Vec3; operation?: "new" | "join" | "cut" | "intersect"; body?: string; requireEffect?: boolean; name?: string } & Record<string, unknown>, ctx) {
      const id = ctx.alloc("prim");
      const dims: Record<string, string> = {};
      for (const k of ["x", "y", "z", "radius", "radius2", "height", "tube"] as const) {
        if (p[k] != null) dims[k] = String(p[k]);
      }
      draft.features[id] = {
        id, kind: "primitive", name: p.name ?? (p.shape.charAt(0).toUpperCase() + p.shape.slice(1)),
        shape: p.shape, dims, at: p.at, operation: p.operation ?? "new",
        ...(p.body ? { body: p.body } : {}), ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: `${p.shape}` };
    },
  },
  {
    type: "feature.hole",
    title: "Hole",
    summary: "Drill a hole — simple, counterbored or countersunk, blind or through — at one or more points.",
    description:
      "Cuts a hole into a body at each point in `at` (world-mm hole-mouth centres), drilling along `axis` (default straight down, −Z). `diameter` is the bore (expression). " +
      "Give `depth` for a blind hole — its `bottom` is flat (default) or a 118° `drill` point — or `throughAll` to pass clear through the body. " +
      "`counterbore` {diameter, depth} adds a flat-bottomed recess with a square shoulder at the mouth (for a socket-head cap screw); `countersink` {diameter, angle} adds an angled cone (angle = included, default 90°, for a flat-head screw). " +
      "`body` picks which body (its creating-feature id; default the most recent); `requireEffect` makes a hole that meets nothing an error. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["at", "diameter"],
      additionalProperties: false,
      properties: {
        at: { type: "array", items: { type: "object", required: ["x", "y", "z"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } }, description: "Hole-mouth centres (world mm)." },
        axis: { type: "object", additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "Drill direction (default −Z)." },
        diameter: { type: ["string", "number"], description: "Bore diameter (expr)." },
        depth: { type: ["string", "number"], description: "Blind depth to the drill point (expr). Omit with throughAll." },
        throughAll: { type: "boolean", description: "Pass clear through the body." },
        bottom: { type: "string", enum: ["flat", "drill"], description: "Blind-hole bottom (default flat)." },
        counterbore: { type: "object", required: ["diameter", "depth"], additionalProperties: false, properties: { diameter: { type: ["string", "number"] }, depth: { type: ["string", "number"] } } },
        countersink: { type: "object", required: ["diameter"], additionalProperties: false, properties: { diameter: { type: ["string", "number"] }, angle: { type: ["string", "number"] } } },
        thread: { ...THREAD_SPEC_SCHEMA, description: "Tap the hole: drill at the tap-drill (minor) diameter, then set thread.diameter to the nominal (major)." },
        body: { type: "string", description: "Target body (feature id); default the most recent." },
        requireEffect: { type: "boolean" },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "A Ø6 hole through the top face at two points", params: { at: [{ x: -10, y: 0, z: 20 }, { x: 10, y: 0, z: 20 }], diameter: "6", throughAll: true } },
      { note: "A tapped M8 blind hole (drill Ø6.75, thread to Ø8)", params: { at: [{ x: 0, y: 0, z: 20 }], diameter: "6.75", depth: "16", thread: { form: "metric", pitch: 1.25, diameter: 8, length: 14, internal: true, representation: "modeled" } } },
      { note: "A counterbored hole for an M4 cap screw", params: { at: [{ x: 0, y: 0, z: 10 }], diameter: "4.5", depth: "12", counterbore: { diameter: "8", depth: "4" } } },
      { note: "An 82° countersink for a flat-head screw", params: { at: [{ x: 0, y: 0, z: 6 }], diameter: "4", throughAll: true, countersink: { diameter: "8", angle: "82" } } },
    ],
    apply(draft, p: { at: Vec3[]; axis?: Vec3; diameter: string | number; depth?: string | number; throughAll?: boolean; bottom?: "flat" | "drill"; counterbore?: { diameter: string | number; depth: string | number }; countersink?: { diameter: string | number; angle?: string | number }; thread?: ThreadSpecParams; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      if (!p.throughAll && p.depth == null) throw new Error("hole needs `depth` or `throughAll`");
      const id = ctx.alloc("hole");
      draft.features[id] = {
        id, kind: "hole", name: p.name ?? "Hole", at: p.at, axis: p.axis,
        diameterExpr: String(p.diameter),
        ...(p.throughAll ? { throughAll: true } : { depthExpr: String(p.depth) }),
        ...(p.bottom ? { bottom: p.bottom } : {}),
        ...(p.counterbore ? { counterbore: { diameterExpr: String(p.counterbore.diameter), depthExpr: String(p.counterbore.depth) } } : {}),
        ...(p.countersink ? { countersink: { diameterExpr: String(p.countersink.diameter), ...(p.countersink.angle != null ? { angleExpr: String(p.countersink.angle) } : {}) } } : {}),
        ...(p.thread ? { thread: { ...p.thread, internal: true } } : {}),
        ...(p.body ? { body: p.body } : {}),
        ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: `Hole ×${p.at.length}` };
    },
  },
  {
    type: "feature.thread",
    title: "Thread",
    summary: "Add an external thread or cut an internal one — any standard form (metric, unified, ACME, trapezoidal, square, buttress), ballscrew, or custom; cosmetic or fully modelled.",
    description:
      "Builds a thread at `at` along `axis` (default +Z, the threaded length running from the point). `spec` gives the form, pitch, (major) diameter and length. " +
      "`spec.internal` cuts the thread into a body as a tap (the body should already have a tap-drill bore at the minor diameter); otherwise it is external — `operation` \"new\" makes a standalone threaded rod, \"join\" adds the threads onto an existing shaft (`body` picks which). " +
      "`spec.representation` \"cosmetic\" (default) keeps the solid a plain cylinder and shades the thread with a procedural normal-map texture (cheap, and it exports as a plain cylinder); \"modeled\" is real helical geometry (heavier — several seconds — and it automatically falls back to cosmetic with a warning if the kernel can't form it cleanly). " +
      "`spec.leftHand`, `spec.starts` (multi-start), `spec.depth` (radial height override) and a `spec.profilePoints` custom section are supported. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["at", "spec"],
      additionalProperties: false,
      properties: {
        at: { ...V3_SCHEMA, required: ["x", "y", "z"], description: "Base point of the threaded length (world mm)." },
        axis: { ...V3_SCHEMA, description: "Thread axis direction (default +Z)." },
        spec: THREAD_SPEC_SCHEMA,
        operation: { type: "string", enum: ["new", "join", "cut"], description: "external only: standalone rod (new) or added to a shaft (join)." },
        body: { type: "string", description: "Target body for join/cut; default the most recent." },
        requireEffect: { type: "boolean" },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "A modelled M10×1.5 external thread, 20mm long, as its own rod", params: { at: { x: 0, y: 0, z: 0 }, spec: { form: "metric", pitch: 1.5, diameter: 10, length: 20, representation: "modeled" } } },
      { note: "A cosmetic ½-10 ACME leadscrew", params: { at: { x: 0, y: 0, z: 0 }, spec: { form: "acme", pitch: 2.54, diameter: 12.7, length: 60 } } },
      { note: "A 2-start ballscrew", params: { at: { x: 0, y: 0, z: 0 }, spec: { form: "ballscrew", pitch: 5, diameter: 16, length: 50, starts: 2, representation: "modeled" } } },
    ],
    apply(draft, p: { at: Vec3; axis?: Vec3; spec: ThreadSpecParams; operation?: "new" | "join" | "cut"; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      const id = ctx.alloc("thr");
      draft.features[id] = {
        id, kind: "thread", name: p.name ?? `Thread ${p.spec.form}`, at: p.at, axis: p.axis, spec: p.spec,
        ...(p.operation ? { operation: p.operation } : {}),
        ...(p.body ? { body: p.body } : {}),
        ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: `Thread ${p.spec.form}` };
    },
  },
  {
    type: "feature.loft",
    title: "Loft",
    summary: "Loft a solid through an ordered list of profile sketches.",
    description:
      "Builds a solid that passes through each profile sketch in `sketches` order (the first closed region of each — typically on different planes or datum/offset planes). `ruled` makes straight sections between profiles instead of a smooth blend. `operation` combines it with existing bodies (new/join/cut). Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["sketches"],
      additionalProperties: false,
      properties: {
        sketches: { type: "array", items: { type: "string" }, description: "Ordered profile sketch ids (at least two)." },
        ruled: { type: "boolean", description: "Straight sections between profiles (default false = smooth)." },
        operation: { type: "string", enum: ["new", "join", "cut", "intersect"], description: "Combine with existing bodies." },
        body: { type: "string", description: "Target body (feature id) for join/cut/intersect; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a join/cut that changes nothing an error." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "Loft through two profiles", params: { sketches: ["sketch1", "sketch3"] } }],
    apply(draft, p: { sketches: string[]; ruled?: boolean; operation?: "new" | "join" | "cut" | "intersect"; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      if (!Array.isArray(p.sketches) || p.sketches.length < 2) throw new Error("loft needs at least two sketches");
      for (const sid of p.sketches) if (!draft.sketches[sid]) throw new Error(`No sketch "${sid}"`);
      const id = ctx.alloc("loft");
      draft.features[id] = {
        id,
        kind: "loft",
        name: p.name ?? "Loft",
        sketchIds: [...p.sketches],
        ruled: !!p.ruled,
        operation: p.operation ?? "new",
        ...(p.body ? { body: p.body } : {}),
        ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: `Loft ${p.sketches.length} profiles` };
    },
  },
  {
    type: "feature.sweep",
    title: "Sweep",
    summary: "Sweep a closed profile along an open path sketch.",
    description:
      "Drags the `profile` sketch's region along the `path` sketch (an open chain of lines/arcs — its spine), producing a solid like a pipe or extrusion that follows the route. `operation` combines it with existing bodies. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["profile", "path"],
      additionalProperties: false,
      properties: {
        profile: { type: "string", description: "Closed profile sketch id (its first region)." },
        path: { type: "string", description: "Open path sketch id (lines/arcs forming a chain)." },
        operation: { type: "string", enum: ["new", "join", "cut", "intersect"], description: "Combine with existing bodies." },
        body: { type: "string", description: "Target body (feature id) for join/cut/intersect; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a join/cut that changes nothing an error." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "Sweep a circle along an L-path", params: { profile: "sketch1", path: "sketch2" } }],
    apply(draft, p: { profile: string; path: string; operation?: "new" | "join" | "cut" | "intersect"; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      if (!draft.sketches[p.profile]) throw new Error(`No profile sketch "${p.profile}"`);
      if (!draft.sketches[p.path]) throw new Error(`No path sketch "${p.path}"`);
      const id = ctx.alloc("swp");
      draft.features[id] = {
        id,
        kind: "sweep",
        name: p.name ?? "Sweep",
        profileSketch: p.profile,
        pathSketch: p.path,
        operation: p.operation ?? "new",
        ...(p.body ? { body: p.body } : {}),
        ...(p.requireEffect ? { requireEffect: true } : {}),
      };
      return { createdIds: [id], message: "Sweep profile along path" };
    },
  },
  {
    type: "feature.fillet",
    title: "Fillet edges",
    summary: "Round selected edges of the most recent body.",
    description:
      "Rounds the body's edges matched by `edges` (an EdgeSelector; every field set narrows the match, empty = all edges) with `radius` (expression). " +
      "Selector fields: parallelTo X/Y/Z (edge direction), inPlane {plane, offset} (e.g. the top-face outline of a 20-tall block on XY: {plane:\"XY\", offset:20}), curveType line/circle, minLength/maxLength, nearPoint {x,y,z}, inBox {min,max}. " +
      "Applies to the most recent body. Fails if the radius does not fit — try a smaller radius or a narrower selection. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["radius"],
      additionalProperties: false,
      properties: {
        radius: { type: "string", description: "Radius expression, e.g. '2' or 'r_edge'." },
        edges: EDGE_SELECTOR_SCHEMA,
        body: { type: "string", description: "Target body (feature id) to round; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a fillet that matches no edges an error." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "Round every edge by 1.5", params: { radius: "1.5" } },
      { note: "Round only the vertical corner edges of a crate", params: { radius: "4", edges: { parallelTo: "Z" } } },
      { note: "Round the top outline of a 30-tall block", params: { radius: "3", edges: { inPlane: { plane: "XY", offset: 30 } } } },
    ],
    apply(draft, p: { radius: string | number; edges?: EdgeSelectorParams; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      const id = ctx.alloc("fil");
      draft.features[id] = { id, kind: "fillet", name: p.name ?? "Fillet", sizeExpr: String(p.radius), sizeValue: 0, edges: p.edges ?? {}, ...(p.body ? { body: p.body } : {}), ...(p.requireEffect ? { requireEffect: true } : {}) };
      return { createdIds: [id], message: "Fillet edges" };
    },
  },
  {
    type: "feature.chamfer",
    title: "Chamfer edges",
    summary: "Bevel selected edges of the most recent body.",
    description:
      "Bevels the body's edges matched by `edges` (same EdgeSelector as feature.fillet; empty = all edges) by `distance` (expression, the setback along each face). Applies to the most recent body. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["distance"],
      additionalProperties: false,
      properties: {
        distance: { type: "string", description: "Setback expression." },
        edges: EDGE_SELECTOR_SCHEMA,
        body: { type: "string", description: "Target body (feature id) to bevel; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a chamfer that matches no edges an error." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "Bevel the crown of a bolt head (its top outline at z=38)", params: { distance: "1", edges: { inPlane: { plane: "XY", offset: 38 } } } }],
    apply(draft, p: { distance: string | number; edges?: EdgeSelectorParams; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      const id = ctx.alloc("cha");
      draft.features[id] = { id, kind: "chamfer", name: p.name ?? "Chamfer", sizeExpr: String(p.distance), sizeValue: 0, edges: p.edges ?? {}, ...(p.body ? { body: p.body } : {}), ...(p.requireEffect ? { requireEffect: true } : {}) };
      return { createdIds: [id], message: "Chamfer edges" };
    },
  },
  {
    type: "feature.shell",
    title: "Shell",
    summary: "Hollow the most recent body to a wall thickness, opening the selected faces.",
    description:
      "Turns the most recent body into a thin-walled shell of `thickness` (expression), removing the faces matched by `openFaces` (a FaceSelector: parallelTo XY/XZ/YZ, inPlane {plane, offset}, nearPoint {x,y,z}) as openings. At least one face must open. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["thickness", "openFaces"],
      additionalProperties: false,
      properties: {
        thickness: { type: "string", description: "Wall thickness expression." },
        openFaces: FACE_SELECTOR_SCHEMA,
        body: { type: "string", description: "Target body (feature id) to hollow; default the most recent." },
        requireEffect: { type: "boolean", description: "Make a shell that matches no faces an error." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "An open-top box with 2mm walls from a 50-tall block", params: { thickness: "2", openFaces: { inPlane: { plane: "XY", offset: 50 } } } }],
    apply(draft, p: { thickness: string | number; openFaces: FaceSelectorParams; body?: string; requireEffect?: boolean; name?: string }, ctx) {
      const id = ctx.alloc("shl");
      draft.features[id] = { id, kind: "shell", name: p.name ?? "Shell", thicknessExpr: String(p.thickness), thicknessValue: 0, openFaces: p.openFaces ?? {}, ...(p.body ? { body: p.body } : {}), ...(p.requireEffect ? { requireEffect: true } : {}) };
      return { createdIds: [id], message: "Shell" };
    },
  },
  {
    type: "feature.pattern",
    title: "Pattern body",
    summary: "Repeat the most recent body along a vector (linear) or around an axis (circular), fusing the copies in.",
    description:
      "Makes `count` instances of the most recent body (including the original) and fuses them into one body. linear: each instance is offset by `step` {x,y,z} (world mm). circular: instances are rotated about `axis` {origin, direction} by `angle` degrees each (default 360/count). " +
      "`count`, each `step` component and `angle` accept an expression (string) referencing parameters — so the instance count can be driven by a parameter (e.g. count \"stages\"); count is rounded to an integer ≥1. " +
      "Build the single element first (e.g. one picket, one tooth), then pattern it. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["mode", "count"],
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["linear", "circular"] },
        count: { type: ["integer", "string"], description: "Instance count (integer ≥1), or an expression like \"stages\" (rounded to an int)." },
        step: { type: "object", properties: { x: { type: ["number", "string"] }, y: { type: ["number", "string"] }, z: { type: ["number", "string"] } }, description: "linear: offset between instances (each component a number or expression)." },
        axis: {
          type: "object",
          properties: {
            origin: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
            direction: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
          },
          description: "circular: axis origin + direction (world).",
        },
        angle: { type: ["number", "string"], description: "circular: degrees between instances (number or expression; default 360/count)." },
        body: { type: "string", description: "Target body (feature id) to repeat; default the most recent." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "9 fence pickets 13mm apart along X", params: { mode: "linear", count: 9, step: { x: 13, y: 0, z: 0 } } },
      { note: "Parametric stack: `stages` copies, spaced by `rise`", params: { mode: "linear", count: "stages", step: { x: 0, y: 0, z: "rise" } } },
      { note: "16 gear teeth around Z", params: { mode: "circular", count: 16, axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } } } },
    ],
    apply(draft, p: { mode: "linear" | "circular"; count: number | string; step?: { x?: number | string; y?: number | string; z?: number | string }; axis?: { origin: Vec3; direction: Vec3 }; angle?: number | string; body?: string; name?: string }, ctx) {
      if (p.mode === "linear" && !p.step) throw new Error("linear pattern needs `step`");
      if (p.mode === "circular" && !p.axis) throw new Error("circular pattern needs `axis`");
      // Split literal numbers (stored as `count`/`step`/`angle`) from expressions
      // (stored as `*Expr` and resolved against the parameter scope at rebuild).
      const num = (v: number | string | undefined, dflt: number): { val: number; expr?: string } => {
        if (v == null) return { val: dflt };
        if (typeof v === "number") return { val: v };
        const f = parseFloat(v);
        return { val: Number.isFinite(f) ? f : dflt, expr: v };
      };
      const c = num(p.count, 1);
      const s = p.step ? { x: num(p.step.x, 0), y: num(p.step.y, 0), z: num(p.step.z, 0) } : undefined;
      const a = num(p.angle, NaN);
      const stepExpr = s && (s.x.expr || s.y.expr || s.z.expr)
        ? { ...(s.x.expr ? { x: s.x.expr } : {}), ...(s.y.expr ? { y: s.y.expr } : {}), ...(s.z.expr ? { z: s.z.expr } : {}) }
        : undefined;
      const id = ctx.alloc("pat");
      draft.features[id] = {
        id, kind: "pattern", name: p.name ?? (p.mode === "linear" ? "Linear pattern" : "Circular pattern"),
        mode: p.mode, count: Math.max(1, Math.round(c.val)), ...(c.expr ? { countExpr: c.expr } : {}),
        step: s ? { x: s.x.val, y: s.y.val, z: s.z.val } : undefined, ...(stepExpr ? { stepExpr } : {}),
        axis: p.axis, ...(p.angle != null ? { angle: a.val } : {}), ...(a.expr ? { angleExpr: a.expr } : {}),
        ...(p.body ? { body: p.body } : {}),
      };
      return { createdIds: [id], message: `${p.mode} pattern × ${c.expr ?? Math.max(1, Math.round(c.val))}` };
    },
  },
  {
    type: "feature.mirror",
    title: "Mirror bodies",
    summary: "Reflect the model across a plane and fuse the reflection in (symmetry).",
    description:
      "Reflects bodies across a plane and fuses each reflection into its source body, giving a symmetric result. `bodies` \"all\" (default) reflects every body; \"last\" only the most recent one (mirror a wheel, not the whole dumpster). `plane` is an origin plane (XY/XZ/YZ) or a datum plane id (from plane.create). Parametric: editing the upstream geometry re-mirrors. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["plane"],
      additionalProperties: false,
      properties: {
        plane: { type: "string", description: "Mirror plane: XY/XZ/YZ or a datum plane id." },
        bodies: { type: "string", enum: ["all", "last"], description: "Every body (default) or only the most recent one." },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "Mirror the model across the YZ plane", params: { plane: "YZ" } },
      { note: "Mirror just the last body (e.g. one wheel) across XZ", params: { plane: "XZ", bodies: "last" } },
    ],
    apply(draft, p: { plane: string; bodies?: "all" | "last"; name?: string }, ctx) {
      if (!["XY", "XZ", "YZ"].includes(p.plane) && !draft.planes[p.plane]) throw new Error(`No mirror plane "${p.plane}"`);
      const id = ctx.alloc("mir");
      draft.features[id] = { id, kind: "mirror", name: p.name ?? "Mirror", plane: p.plane, ...(p.bodies === "last" ? { bodies: "last" as const } : {}) };
      return { createdIds: [id], message: `Mirror across ${p.plane}` };
    },
  },

  // ---- modify (mirror / pattern / construction) ----
  {
    type: "sketch.mirror",
    title: "Mirror",
    summary: "Mirror entities across a line to create reflected copies.",
    description:
      "Creates mirrored copies of `entities` (points/lines/circles/arcs) reflected across the infinite line through `line`'s endpoints. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "entities", "line"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        line: { type: "string", description: "A line entity used as the mirror axis." },
      },
    },
    apply(draft, p: { sketch: string; entities: string[]; line: string }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const axis = sk.entities[p.line];
      if (!axis || axis.kind !== "line") throw new Error("mirror axis must be a line");
      const A = sk.entities[axis.p1] as SketchPoint;
      const B = sk.entities[axis.p2] as SketchPoint;
      const dx = B.x - A.x, dy = B.y - A.y;
      const len2 = dx * dx + dy * dy || 1;
      const reflect = (x: number, y: number): [number, number] => {
        const t = ((x - A.x) * dx + (y - A.y) * dy) / len2;
        const fx = A.x + t * dx, fy = A.y + t * dy;
        return [2 * fx - x, 2 * fy - y];
      };
      const map = new Map<string, string>();
      const mp = (id: string): string => {
        if (map.has(id)) return map.get(id)!;
        const o = sk.entities[id] as SketchPoint;
        const [rx, ry] = reflect(o.x, o.y);
        const nid = ctx.alloc("pt");
        sk.entities[nid] = { id: nid, kind: "point", x: rx, y: ry, construction: o.construction };
        map.set(id, nid);
        return nid;
      };
      const created: string[] = [];
      for (const eid of p.entities) {
        const e = sk.entities[eid];
        if (!e) continue;
        if (e.kind === "point") created.push(mp(eid));
        else if (e.kind === "line") {
          const nid = ctx.alloc("ln");
          sk.entities[nid] = { id: nid, kind: "line", p1: mp(e.p1), p2: mp(e.p2), construction: e.construction };
          created.push(nid);
        } else if (e.kind === "circle") {
          const nid = ctx.alloc("ci");
          sk.entities[nid] = { id: nid, kind: "circle", center: mp(e.center), r: e.r, construction: e.construction };
          created.push(nid);
        } else if (e.kind === "arc") {
          const nid = ctx.alloc("ar");
          // reflection reverses orientation: swap endpoints and flip sweep
          sk.entities[nid] = { id: nid, kind: "arc", center: mp(e.center), p1: mp(e.p2), p2: mp(e.p1), r: e.r, ccw: !e.ccw, construction: e.construction };
          created.push(nid);
        }
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Mirrored ${created.length} entit${created.length === 1 ? "y" : "ies"}` };
    },
  },
  {
    type: "sketch.linearPattern",
    title: "Linear pattern",
    summary: "Repeat entities along a direction.",
    description:
      "Creates `count`-1 copies of `entities`, each offset by (dx, dy) * i. count includes the original. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "entities", "dx", "dy", "count"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        dx: { type: "number" },
        dy: { type: "number" },
        count: { type: "integer", minimum: 2 },
      },
    },
    apply(draft, p: { sketch: string; entities: string[]; dx: number; dy: number; count: number }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const created: string[] = [];
      for (let i = 1; i < p.count; i++) {
        const map = new Map<string, string>();
        const off = (id: string): string => {
          if (map.has(id)) return map.get(id)!;
          const o = sk.entities[id] as SketchPoint;
          const nid = ctx.alloc("pt");
          sk.entities[nid] = { id: nid, kind: "point", x: o.x + p.dx * i, y: o.y + p.dy * i, construction: o.construction };
          map.set(id, nid);
          return nid;
        };
        for (const eid of p.entities) {
          const e = sk.entities[eid];
          if (!e) continue;
          if (e.kind === "point") created.push(off(eid));
          else if (e.kind === "line") { const nid = ctx.alloc("ln"); sk.entities[nid] = { id: nid, kind: "line", p1: off(e.p1), p2: off(e.p2), construction: e.construction }; created.push(nid); }
          else if (e.kind === "circle") { const nid = ctx.alloc("ci"); sk.entities[nid] = { id: nid, kind: "circle", center: off(e.center), r: e.r, construction: e.construction }; created.push(nid); }
          else if (e.kind === "arc") { const nid = ctx.alloc("ar"); sk.entities[nid] = { id: nid, kind: "arc", center: off(e.center), p1: off(e.p1), p2: off(e.p2), r: e.r, ccw: e.ccw, construction: e.construction }; created.push(nid); }
        }
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Patterned ×${p.count}` };
    },
  },
  {
    type: "sketch.circularPattern",
    title: "Circular pattern",
    summary: "Repeat entities around a center point.",
    description:
      "Creates `count`-1 rotated copies of `entities` about (cx, cy), each turned `step` degrees from the previous (positive = counter-clockwise). count includes the original. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "entities", "cx", "cy", "count", "step"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        cx: { type: "number" },
        cy: { type: "number" },
        count: { type: "integer", minimum: 2 },
        step: { type: "number", description: "Degrees between copies." },
      },
    },
    apply(draft, p: { sketch: string; entities: string[]; cx: number; cy: number; count: number; step: number }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const created: string[] = [];
      for (let i = 1; i < p.count; i++) {
        const a = (p.step * i * Math.PI) / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const tf = (pt: Vec): Vec => {
          const dx = pt.x - p.cx, dy = pt.y - p.cy;
          return { x: p.cx + dx * cos - dy * sin, y: p.cy + dx * sin + dy * cos };
        };
        created.push(...copyEntities(sk, p.entities, ctx, tf));
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Circular ×${p.count}` };
    },
  },
  {
    type: "sketch.gridPattern",
    title: "Grid pattern",
    summary: "Repeat entities in a 2D grid.",
    description:
      "Creates a `countX` × `countY` grid of `entities` spaced (dx, dy), omitting the original cell. Counts include the original row/column. Returns the created ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "entities", "dx", "dy", "countX", "countY"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        dx: { type: "number" },
        dy: { type: "number" },
        countX: { type: "integer", minimum: 1 },
        countY: { type: "integer", minimum: 1 },
      },
    },
    apply(draft, p: { sketch: string; entities: string[]; dx: number; dy: number; countX: number; countY: number }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const created: string[] = [];
      for (let i = 0; i < p.countX; i++) {
        for (let j = 0; j < p.countY; j++) {
          if (i === 0 && j === 0) continue;
          const tf = (pt: Vec): Vec => ({ x: pt.x + p.dx * i, y: pt.y + p.dy * j });
          created.push(...copyEntities(sk, p.entities, ctx, tf));
        }
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Grid ${p.countX}×${p.countY}` };
    },
  },
  {
    type: "sketch.setConstruction",
    title: "Toggle construction",
    summary: "Mark entities as construction (reference) geometry, or back to real.",
    description: "Sets the construction flag on entities. Construction geometry is dashed and excluded from extrude profiles (useful for mirror axes and references).",
    paramsSchema: {
      type: "object",
      required: ["sketch", "ids", "construction"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        construction: { type: "boolean" },
      },
    },
    apply(draft, p: { sketch: string; ids: string[]; construction: boolean }) {
      const sk = sketchOf(draft, p.sketch);
      for (const id of p.ids) {
        const e = sk.entities[id];
        if (e && id !== sk.originPointId) (e as { construction?: boolean }).construction = p.construction;
      }
      return { affectedSketchId: sk.id };
    },
  },

  {
    type: "sketch.deleteConstraints",
    title: "Delete constraint",
    summary: "Remove constraints by id (works even for ones created by composite tools).",
    description:
      "Removes the given constraint ids from a sketch. Applied during replay after the constraints are created, so it reliably removes constraints regardless of which command created them (including rectangle/mirror).",
    paramsSchema: {
      type: "object",
      required: ["sketch", "ids"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
      },
    },
    apply(draft, p: { sketch: string; ids: string[] }) {
      const sk = sketchOf(draft, p.sketch);
      let n = 0;
      for (const id of p.ids) {
        if (sk.constraints[id]) { delete sk.constraints[id]; n++; }
      }
      return { affectedSketchId: sk.id, message: `Deleted ${n} constraint${n === 1 ? "" : "s"}` };
    },
  },
  {
    type: "sketch.deleteEntities",
    title: "Delete entities",
    summary: "Delete entities (and any constraints that reference them) from a sketch.",
    description: "Removes the given entity ids and drops constraints that reference them. The origin point cannot be deleted.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "ids"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
      },
    },
    apply(draft, p: { sketch: string; ids: string[] }) {
      const sk = sketchOf(draft, p.sketch);
      const remove = new Set(p.ids.filter((id) => id !== sk.originPointId));
      for (const id of remove) delete sk.entities[id];
      for (const [cid, c] of Object.entries(sk.constraints)) {
        const refs = Object.values(c).filter((v) => typeof v === "string") as string[];
        if (refs.some((r) => remove.has(r))) delete sk.constraints[cid];
      }
      return { affectedSketchId: sk.id, message: `Deleted ${remove.size} entit${remove.size === 1 ? "y" : "ies"}` };
    },
  },
  {
    type: "sketch.fillet",
    title: "Fillet",
    summary: "Round the corner where two lines meet with a tangent arc.",
    description:
      "Replaces the shared corner of two lines with a tangent arc of the given radius, trimming both lines back to the tangent points. Constraints on each trimmed edge are preserved. Returns [arcId, centerId, tangent1, tangent2].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "radius"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        line1: { type: "string" },
        line2: { type: "string" },
        point: { type: "string", description: "Alternative to line1/line2: the corner point id where exactly two lines meet." },
        radius: { type: "number", minimum: 0 },
      },
    },
    examples: [
      { note: "5mm round on a corner", params: { sketch: "sketch1", line1: "ln3", line2: "ln6", radius: 5 } },
      { note: "Same, by corner point", params: { sketch: "sketch1", point: "pt7", radius: 5 } },
    ],
    apply(draft, p: { sketch: string; line1?: string; line2?: string; point?: string; radius: number }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const [a, b] = cornerLines(sk, p);
      return blendCorner(sk, a, b, p.radius, ctx, "fillet");
    },
  },
  {
    type: "sketch.chamfer",
    title: "Chamfer",
    summary: "Bevel the corner where two lines meet with a straight segment.",
    description:
      "Replaces the shared corner of two lines with a straight chamfer, setting back `distance` along each edge. Constraints on each trimmed edge are preserved. Returns [lineId, tangent1, tangent2].",
    paramsSchema: {
      type: "object",
      required: ["sketch", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        line1: { type: "string" },
        line2: { type: "string" },
        point: { type: "string", description: "Alternative to line1/line2: the corner point id where exactly two lines meet." },
        distance: { type: "number", minimum: 0 },
      },
    },
    examples: [{ note: "3mm chamfer", params: { sketch: "sketch1", line1: "ln3", line2: "ln6", distance: 3 } }],
    apply(draft, p: { sketch: string; line1?: string; line2?: string; point?: string; distance: number }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const [a, b] = cornerLines(sk, p);
      return blendCorner(sk, a, b, p.distance, ctx, "chamfer");
    },
  },
  {
    type: "sketch.filletCorners",
    title: "Fillet corners",
    summary: "Round (or bevel) many corners at once — by default every corner where exactly two lines meet.",
    description:
      "Applies a fillet (`mode` \"fillet\", default) or chamfer to each corner in `points`, or — when `points` is omitted — to every sketch point where exactly two non-construction lines meet. Corners the size does not fit are skipped and listed in the message. Returns the created arc/line and tangent point ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "size"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        points: { type: "array", items: { type: "string" }, description: "Corner point ids. Omit for every two-line corner." },
        size: { type: "number", minimum: 0, description: "Fillet radius or chamfer setback." },
        mode: { type: "string", enum: ["fillet", "chamfer"] },
      },
    },
    examples: [{ note: "Round every corner of a plate outline by 4mm", params: { sketch: "sketch1", size: 4 } }],
    apply(draft, p: { sketch: string; points?: string[]; size: number; mode?: "fillet" | "chamfer" }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const pts = p.points ?? Object.values(sk.entities).filter((e) => e.kind === "point" && linesAt(sk, e.id).length === 2).map((e) => e.id);
      const created: string[] = [];
      const skipped: string[] = [];
      for (const pid of pts) {
        const ls = linesAt(sk, pid);
        if (ls.length !== 2) { skipped.push(pid); continue; }
        try { created.push(...(blendCorner(sk, ls[0], ls[1], p.size, ctx, p.mode ?? "fillet").createdIds ?? [])); }
        catch { skipped.push(pid); }
      }
      return { createdIds: created, affectedSketchId: sk.id, message: `Blended ${pts.length - skipped.length} corner(s)${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}` };
    },
  },
  {
    type: "sketch.offsetLoop",
    title: "Offset loop",
    summary: "Offset a closed loop of lines inward or outward by a distance (an inset/outset copy of a profile).",
    description:
      "Takes the lines of one closed polygon (`lines`), orders them into a loop and creates a parallel copy offset by `distance`: positive = outward, negative = inward (inset). Corners are mitred. Lines only (no arcs). Returns the new point ids followed by the new line ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "lines", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        lines: { type: "array", items: { type: "string" }, description: "The line ids of one closed loop (any order)." },
        distance: { type: "number", description: "Offset distance: > 0 outward, < 0 inward." },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [{ note: "An 8mm inset of a plate outline for a recess", params: { sketch: "sketch1", lines: ["ln5", "ln6", "ln7", "ln8"], distance: -8 } }],
    apply(draft, p: { sketch: string; lines: string[]; distance: number; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const loop = orderLoop(sk, p.lines);
      const pts = loop.map((id) => sk.entities[id] as SketchPoint);
      // Signed area → orientation, so "outward" is independent of winding.
      let area = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
      const ccw = area > 0;
      const d = ccw ? p.distance : -p.distance;
      const n = pts.length;
      const newPts: string[] = [];
      for (let i = 0; i < n; i++) {
        const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
        // Unit edge directions and their right-hand normals (outward for a CCW loop with d>0).
        const e1 = norm2({ x: cur.x - prev.x, y: cur.y - prev.y });
        const e2 = norm2({ x: next.x - cur.x, y: next.y - cur.y });
        const n1 = { x: e1.y, y: -e1.x }, n2 = { x: e2.y, y: -e2.x };
        const bis = norm2({ x: n1.x + n2.x, y: n1.y + n2.y });
        const cosHalf = bis.x * n1.x + bis.y * n1.y;
        const len = Math.abs(cosHalf) < 1e-6 ? d : d / cosHalf; // mitre length
        const id = ctx.alloc("pt");
        sk.entities[id] = { id, kind: "point", x: cur.x + bis.x * len, y: cur.y + bis.y * len };
        newPts.push(id);
      }
      const newLines: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = ctx.alloc("ln");
        sk.entities[id] = { id, kind: "line", p1: newPts[i], p2: newPts[(i + 1) % n], construction: !!p.construction };
        newLines.push(id);
      }
      return { createdIds: [...newPts, ...newLines], affectedSketchId: sk.id, message: `Offset loop by ${p.distance}` };
    },
  },
  {
    type: "sketch.trim",
    title: "Trim",
    summary: "Remove the clicked piece of a curve, bounded by its intersections.",
    description:
      "Trims the curve `target` at the point (u,v): removes the span between the nearest intersections with other curves on either side of the click. A line/arc may split in two or shorten; a circle becomes an arc; an unbounded click deletes the curve. Returns the ids of any new fragments.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "target", "u", "v"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        target: { type: "string" },
        u: { type: "number" },
        v: { type: "number" },
      },
    },
    examples: [{ note: "Trim line ln4 near (12,0)", params: { sketch: "sketch1", target: "ln4", u: 12, v: 0 } }],
    apply(draft, p: { sketch: string; target: string; u: number; v: number }, ctx) {
      return trimCurve(sketchOf(draft, p.sketch), p.target, p.u, p.v, ctx);
    },
  },
  {
    type: "sketch.extend",
    title: "Extend",
    summary: "Lengthen a line or arc to the next curve it meets.",
    description:
      "Extends the end of `target` nearest the click point (u,v) until it reaches the closest other curve along its own path. Moves that endpoint; adds no new entities.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "target", "u", "v"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        target: { type: "string" },
        u: { type: "number" },
        v: { type: "number" },
      },
    },
    apply(draft, p: { sketch: string; target: string; u: number; v: number }) {
      return extendCurve(sketchOf(draft, p.sketch), p.target, p.u, p.v);
    },
  },
  {
    type: "sketch.offset",
    title: "Offset",
    summary: "Create a parallel copy of a curve at a signed distance.",
    description:
      "Offsets a single line, circle or arc by `distance` (perpendicular for lines, radial for circles/arcs; negative flips the side / shrinks the radius). Returns the created entity ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "target", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        target: { type: "string" },
        distance: { type: "number" },
      },
    },
    apply(draft, p: { sketch: string; target: string; distance: number }, ctx) {
      return offsetCurve(sketchOf(draft, p.sketch), p.target, p.distance, ctx);
    },
  },
];
