// Built-in commands. Every mutation the UI or an agent performs is one of
// these. Each is documented with a JSON Schema + examples so it can be exposed
// directly as an MCP tool.

import { CadDocument } from "../document";
import {
  DimensionConstraint,
  GeometricConstraint,
  Sketch,
  SketchLine,
  SketchPoint,
} from "../../sketch/types";
import { CommandRegistry } from "./registry";
import { CommandApplyInfo, CommandContext, CommandDef, JSONSchema } from "./types";
import { ICurve, intersect, paramOf, pointAt } from "../geometry/intersect";

const PLANE_ENUM = ["XY", "XZ", "YZ"];

// A point given either as coordinates (creates a new point) or a ref to an
// existing point id (reuses it — which is how coincidence is expressed).
const POINT_REF_SCHEMA: JSONSchema = {
  description: "A point: either {x,y} to create one, or {ref: <pointId>} to reuse an existing one.",
  oneOf: [
    { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
    { type: "object", required: ["ref"], properties: { ref: { type: "string" } } },
  ],
};

type PointRef = { x: number; y: number } | { ref: string };

function sketchOf(doc: CadDocument, id: unknown): Sketch {
  const sk = doc.sketches[String(id)];
  if (!sk) throw new Error(`No sketch "${id}"`);
  return sk;
}

function resolvePoint(sk: Sketch, ref: PointRef, ctx: CommandContext): string {
  if ("ref" in ref) {
    if (!sk.entities[ref.ref]) throw new Error(`No entity "${ref.ref}" in sketch`);
    return ref.ref;
  }
  const id = ctx.alloc("pt");
  sk.entities[id] = { id, kind: "point", x: ref.x, y: ref.y };
  return id;
}

export function createDefaultRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const def of BUILTINS) reg.register(def);
  return reg;
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
      },
    },
    examples: [{ params: { name: "width", expression: "60" } }],
    apply(draft, p: { name: string; expression: string }, ctx) {
      if (draft.parameters.some((x) => x.name === p.name)) throw new Error(`Parameter "${p.name}" exists`);
      const id = ctx.alloc("param");
      draft.parameters.push({ id, name: p.name, expr: p.expression, value: 0 });
      return { createdIds: [id], message: `Added parameter ${p.name}` };
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

  // ---- sketch lifecycle ----
  {
    type: "sketch.create",
    title: "Create sketch",
    summary: "Start a new sketch on an origin plane (XY, XZ, or YZ).",
    description:
      "Creates a sketch bound to one of the three origin planes, with a fixed origin point at (0,0). Returns the sketch id and the origin point id (first createdId is the sketch, second is the origin).",
    paramsSchema: {
      type: "object",
      required: ["plane"],
      additionalProperties: false,
      properties: {
        plane: { type: "string", enum: PLANE_ENUM, description: "Origin plane." },
        name: { type: "string", description: "Optional sketch name." },
      },
    },
    examples: [{ note: "Sketch on the front plane", params: { plane: "XZ" } }],
    apply(draft, p: { plane: string; name?: string }, ctx) {
      const sid = ctx.alloc("sketch");
      const originId = ctx.alloc("pt");
      const count = Object.keys(draft.sketches).length + 1;
      const origin: SketchPoint = { id: originId, kind: "point", x: 0, y: 0, fixed: true };
      draft.sketches[sid] = {
        id: sid,
        name: p.name ?? `Sketch ${count}`,
        planeId: p.plane,
        originPointId: originId,
        entities: { [originId]: origin },
        constraints: {},
        status: { dof: 0, fullyConstrained: false, converged: true, conflicting: false },
      };
      draft.components[draft.rootComponentId].sketches.push(sid);
      return { createdIds: [sid, originId], affectedSketchId: sid, message: `Created ${draft.sketches[sid].name}` };
    },
  },

  // ---- geometry ----
  {
    type: "sketch.addPoint",
    title: "Add point",
    summary: "Add a free point to a sketch.",
    description: "Adds a point at (x,y). Set fixed=true to lock it.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "x", "y"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        fixed: { type: "boolean" },
      },
    },
    apply(draft, p: { sketch: string; x: number; y: number; fixed?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const id = ctx.alloc("pt");
      sk.entities[id] = { id, kind: "point", x: p.x, y: p.y, fixed: p.fixed };
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
      },
    },
    examples: [
      { note: "From origin to (60,0)", params: { sketch: "sketch1", start: { ref: "pt2" }, end: { x: 60, y: 0 } } },
    ],
    apply(draft, p: { sketch: string; start: PointRef; end: PointRef }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const a = resolvePoint(sk, p.start, ctx);
      const b = resolvePoint(sk, p.end, ctx);
      const id = ctx.alloc("ln");
      sk.entities[id] = { id, kind: "line", p1: a, p2: b };
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
      },
    },
    apply(draft, p: { sketch: string; center: PointRef; radius: number }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const c = resolvePoint(sk, p.center, ctx);
      const id = ctx.alloc("ci");
      sk.entities[id] = { id, kind: "circle", center: c, r: p.radius };
      return { createdIds: [id, c], affectedSketchId: sk.id };
    },
  },
  {
    type: "sketch.addRectangle",
    title: "Add rectangle",
    summary: "Add a rectangle (4 lines) with horizontal/vertical constraints applied.",
    description:
      "Creates a rectangle between two opposite corners, as 4 coincident lines, and applies 2 horizontal + 2 vertical constraints so it stays rectangular. Returns the 4 corner point ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "corner", "opposite"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        corner: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        opposite: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
      },
    },
    apply(
      draft,
      p: { sketch: string; corner: { x: number; y: number }; opposite: { x: number; y: number } },
      ctx
    ) {
      const sk = sketchOf(draft, p.sketch);
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
        sk.entities[id] = { id, kind: "line", p1: a, p2: b };
      };
      line(p00, p10);
      line(p10, p11);
      line(p11, p01);
      line(p01, p00);
      const con = (c: GeometricConstraint) => (sk.constraints[c.id] = c);
      con({ id: ctx.alloc("c"), type: "horizontal", a: p00, b: p10 });
      con({ id: ctx.alloc("c"), type: "horizontal", a: p01, b: p11 });
      con({ id: ctx.alloc("c"), type: "vertical", a: p00, b: p01 });
      con({ id: ctx.alloc("c"), type: "vertical", a: p10, b: p11 });
      return { createdIds: [p00, p10, p11, p01], affectedSketchId: sk.id };
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
      },
    },
    apply(draft, p: { sketch: string; center: PointRef; start: PointRef; end: PointRef; ccw?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const c = resolvePoint(sk, p.center, ctx);
      const s = resolvePoint(sk, p.start, ctx);
      const e = resolvePoint(sk, p.end, ctx);
      const cp = sk.entities[c] as SketchPoint;
      const sp = sk.entities[s] as SketchPoint;
      const r = Math.hypot(sp.x - cp.x, sp.y - cp.y);
      const id = ctx.alloc("ar");
      sk.entities[id] = { id, kind: "arc", center: c, p1: s, p2: e, r, ccw: p.ccw ?? true };
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
            "coincident", "horizontal", "vertical", "parallel", "perpendicular",
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
    summary: "Extrude a sketch's closed profile into a solid.",
    description:
      "Creates an extruded solid from the closed profile of a sketch, along the sketch plane normal. `distance` is an expression (parametric), e.g. \"10\" or \"height*2\". The largest closed loop is the outer boundary; inner loops become holes. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        distance: { type: "string", description: "Distance expression, e.g. '10' or 'height*2'." },
        symmetric: { type: "boolean", description: "Extrude symmetrically about the plane." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "Extrude sketch1 by the `height` parameter", params: { sketch: "sketch1", distance: "height" } }],
    apply(draft, p: { sketch: string; distance: string | number; symmetric?: boolean; name?: string }, ctx) {
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
      };
      return { createdIds: [id], message: `Extrude ${p.sketch}` };
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
      required: ["sketch", "line1", "line2", "radius"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        line1: { type: "string" },
        line2: { type: "string" },
        radius: { type: "number", minimum: 0 },
      },
    },
    examples: [{ note: "5mm round on a corner", params: { sketch: "sketch1", line1: "ln3", line2: "ln6", radius: 5 } }],
    apply(draft, p: { sketch: string; line1: string; line2: string; radius: number }, ctx) {
      return blendCorner(sketchOf(draft, p.sketch), p.line1, p.line2, p.radius, ctx, "fillet");
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
      required: ["sketch", "line1", "line2", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        line1: { type: "string" },
        line2: { type: "string" },
        distance: { type: "number", minimum: 0 },
      },
    },
    examples: [{ note: "3mm chamfer", params: { sketch: "sketch1", line1: "ln3", line2: "ln6", distance: 3 } }],
    apply(draft, p: { sketch: string; line1: string; line2: string; distance: number }, ctx) {
      return blendCorner(sketchOf(draft, p.sketch), p.line1, p.line2, p.distance, ctx, "chamfer");
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
];

type Vec = { x: number; y: number };

function toICurve(sk: Sketch, e: { kind: string } & Record<string, unknown>): ICurve | null {
  const P = (id: string) => sk.entities[id] as SketchPoint;
  if (e.kind === "line") { const a = P(e.p1 as string), b = P(e.p2 as string); return { kind: "line", a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } }; }
  if (e.kind === "circle") { const c = P(e.center as string); return { kind: "circle", c: { x: c.x, y: c.y }, r: e.r as number }; }
  if (e.kind === "arc") {
    const c = P(e.center as string), s = P(e.p1 as string), t = P(e.p2 as string);
    return { kind: "arc", c: { x: c.x, y: c.y }, r: e.r as number, a0: Math.atan2(s.y - c.y, s.x - c.x), a1: Math.atan2(t.y - c.y, t.x - c.x), ccw: e.ccw as boolean };
  }
  return null;
}

/** Remove orphaned points and any constraints that reference missing entities. */
function pruneSketch(sk: Sketch) {
  const used = new Set<string>();
  for (const e of Object.values(sk.entities)) {
    if (e.kind === "line") { used.add(e.p1); used.add(e.p2); }
    else if (e.kind === "circle") used.add(e.center);
    else if (e.kind === "arc") { used.add(e.center); used.add(e.p1); used.add(e.p2); }
  }
  for (const [id, e] of Object.entries(sk.entities)) {
    if (e.kind === "point" && id !== sk.originPointId && !used.has(id)) delete sk.entities[id];
  }
  for (const [cid, c] of Object.entries(sk.constraints) as [string, Record<string, unknown>][]) {
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === "string" && k !== "id" && k !== "type" && k !== "expr" && !sk.entities[v]) { delete sk.constraints[cid]; break; }
    }
  }
}

function trimCurve(sk: Sketch, targetId: string, u: number, v: number, ctx: CommandContext): CommandApplyInfo {
  const tgt = sk.entities[targetId];
  if (!tgt || tgt.kind === "point") throw new Error("trim target must be a line, circle or arc");
  const tc = toICurve(sk, tgt as any)!;
  const EPS = 1e-4;
  const mkPt = (pt: Vec): string => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x: pt.x, y: pt.y }; return id; };

  // Intersection parameters along the target from every other curve.
  const cuts: number[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.id === targetId || e.kind === "point") continue;
    const oc = toICurve(sk, e as any);
    if (!oc) continue;
    for (const pt of intersect(tc, oc)) cuts.push(paramOf(tc, pt));
  }
  const click = paramOf(tc, { x: u, y: v });
  const created: string[] = [];

  if (tgt.kind === "line" || tgt.kind === "arc") {
    const cu = Math.max(0, Math.min(1, click));
    const inside = cuts.filter((c) => c > EPS && c < 1 - EPS).sort((a, b) => a - b);
    let lo = 0, hi = 1;
    for (const c of inside) if (c <= cu) lo = c;
    for (const c of inside) if (c >= cu) { hi = c; break; }
    const pieces: [number, number][] = [];
    if (lo > EPS) pieces.push([0, lo]);
    if (hi < 1 - EPS) pieces.push([hi, 1]);
    const origP1 = (tgt as { p1: string }).p1;
    const origP2 = (tgt as { p2: string }).p2;

    if (pieces.length === 0) {
      delete sk.entities[targetId];
    } else {
      pieces.forEach(([s, e], i) => {
        const startId = s <= EPS ? origP1 : mkPt(pointAt(tc, s));
        const endId = e >= 1 - EPS ? origP2 : mkPt(pointAt(tc, e));
        if (startId !== origP1 && s > EPS) created.push(startId);
        if (endId !== origP2 && e < 1 - EPS) created.push(endId);
        if (i === 0) {
          (tgt as { p1: string }).p1 = startId;
          (tgt as { p2: string }).p2 = endId;
        } else {
          const nid = ctx.alloc(tgt.kind === "arc" ? "ar" : "ln");
          sk.entities[nid] = tgt.kind === "arc"
            ? { id: nid, kind: "arc", center: (tgt as any).center, p1: startId, p2: endId, r: (tgt as any).r, ccw: (tgt as any).ccw }
            : { id: nid, kind: "line", p1: startId, p2: endId };
          created.push(nid);
        }
      });
    }
  } else {
    // circle → arc (or delete if the click isn't bounded on both sides)
    const inside = cuts.map((c) => ((c % 1) + 1) % 1).sort((a, b) => a - b);
    if (inside.length < 2) {
      delete sk.entities[targetId];
    } else {
      const cu = ((click % 1) + 1) % 1;
      const below = inside.filter((c) => c <= cu);
      const above = inside.filter((c) => c > cu);
      const lo = below.length ? below[below.length - 1] : inside[inside.length - 1];
      const hi = above.length ? above[0] : inside[0];
      const startId = mkPt(pointAt(tc, hi));
      const endId = mkPt(pointAt(tc, lo));
      const arcId = ctx.alloc("ar");
      sk.entities[arcId] = { id: arcId, kind: "arc", center: (tgt as any).center, p1: startId, p2: endId, r: (tgt as any).r, ccw: true };
      delete sk.entities[targetId];
      created.push(arcId, startId, endId);
    }
  }

  pruneSketch(sk);
  return { createdIds: created, affectedSketchId: sk.id, message: "Trimmed" };
}

/** Find the point id two lines share, with each line's far endpoint. */
function sharedCorner(l1: SketchLine, l2: SketchLine): { c: string; a: string; b: string; l1End: "p1" | "p2"; l2End: "p1" | "p2" } | null {
  const e1: ["p1" | "p2", string][] = [["p1", l1.p1], ["p2", l1.p2]];
  const e2: ["p1" | "p2", string][] = [["p1", l2.p1], ["p2", l2.p2]];
  for (const [k1, c1] of e1) for (const [k2, c2] of e2) {
    if (c1 === c2) return { c: c1, a: k1 === "p1" ? l1.p2 : l1.p1, b: k2 === "p1" ? l2.p2 : l2.p1, l1End: k1, l2End: k2 };
  }
  return null;
}

/** Shared implementation of fillet (tangent arc) and chamfer (straight bevel). */
function blendCorner(sk: Sketch, l1id: string, l2id: string, size: number, ctx: CommandContext, mode: "fillet" | "chamfer"): CommandApplyInfo {
  const L1 = sk.entities[l1id];
  const L2 = sk.entities[l2id];
  if (!L1 || L1.kind !== "line" || !L2 || L2.kind !== "line") throw new Error("fillet/chamfer needs two lines");
  const sc = sharedCorner(L1, L2);
  if (!sc) throw new Error("the two lines must share a corner");
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const C = P(sc.c), A = P(sc.a), B = P(sc.b);
  const n = (v: Vec): Vec => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; };
  const u1 = n({ x: A.x - C.x, y: A.y - C.y });
  const u2 = n({ x: B.x - C.x, y: B.y - C.y });
  const len1 = Math.hypot(A.x - C.x, A.y - C.y);
  const len2 = Math.hypot(B.x - C.x, B.y - C.y);
  const cosT = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(cosT);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) throw new Error("the lines are collinear — no corner to blend");

  // Setback distance t along each edge from the corner.
  const t = mode === "fillet" ? size / Math.tan(theta / 2) : size;
  if (t > len1 - 1e-6 || t > len2 - 1e-6) throw new Error(`${mode} is too large for these edges`);

  const T1 = { x: C.x + u1.x * t, y: C.y + u1.y * t };
  const T2 = { x: C.x + u2.x * t, y: C.y + u2.y * t };
  const t1id = ctx.alloc("pt"); sk.entities[t1id] = { id: t1id, kind: "point", x: T1.x, y: T1.y };
  const t2id = ctx.alloc("pt"); sk.entities[t2id] = { id: t2id, kind: "point", x: T2.x, y: T2.y };

  let created: string[];
  let message: string;
  if (mode === "fillet") {
    const bis = n({ x: u1.x + u2.x, y: u1.y + u2.y });
    const dCenter = size / Math.sin(theta / 2);
    const center = { x: C.x + bis.x * dCenter, y: C.y + bis.y * dCenter };
    const cid = ctx.alloc("pt"); sk.entities[cid] = { id: cid, kind: "point", x: center.x, y: center.y };
    const arcId = ctx.alloc("ar");
    const v1 = { x: T1.x - center.x, y: T1.y - center.y };
    const v2 = { x: T2.x - center.x, y: T2.y - center.y };
    const ccw = v1.x * v2.y - v1.y * v2.x > 0; // minor arc T1→T2
    sk.entities[arcId] = { id: arcId, kind: "arc", center: cid, p1: t1id, p2: t2id, r: size, ccw };
    created = [arcId, cid, t1id, t2id];
    message = "Filleted corner";
  } else {
    const lnId = ctx.alloc("ln");
    sk.entities[lnId] = { id: lnId, kind: "line", p1: t1id, p2: t2id };
    created = [lnId, t1id, t2id];
    message = "Chamfered corner";
  }

  // Trim both edges back to their tangent points.
  (L1 as SketchLine)[sc.l1End] = t1id;
  (L2 as SketchLine)[sc.l2End] = t2id;

  // Rehome constraints that used the old corner onto the correct trimmed edge
  // (so e.g. each edge keeps its horizontal/vertical); drop any that can't map.
  for (const con of Object.values(sk.constraints) as Record<string, unknown>[]) {
    const vals = Object.values(con);
    if (!vals.includes(sc.c)) continue;
    const to = vals.includes(sc.a) ? t1id : vals.includes(sc.b) ? t2id : null;
    if (to) { for (const k of Object.keys(con)) if (con[k] === sc.c) con[k] = to; }
    else delete sk.constraints[con.id as string];
  }
  delete sk.entities[sc.c];

  return { createdIds: created, affectedSketchId: sk.id, message };
}
