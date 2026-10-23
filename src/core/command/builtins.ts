// Built-in commands. Every mutation the UI or an agent performs is one of
// these. Each is documented with a JSON Schema + examples so it can be exposed
// directly as an MCP tool.

import { CadDocument } from "../document";
import {
  DimensionConstraint,
  GeometricConstraint,
  Sketch,
  SketchPoint,
} from "../../sketch/types";
import { CommandRegistry } from "./registry";
import { CommandContext, CommandDef, JSONSchema } from "./types";

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
      "equal {e1,e2}; pointOnLine {point,line}; pointOnCircle {point,circle}; concentric {c1,c2}; " +
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
            "equal", "pointOnLine", "pointOnCircle", "concentric", "tangent", "symmetric", "fix",
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
];
