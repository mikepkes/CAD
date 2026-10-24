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
import { makePlaneFromNormal, offsetPlane, planeById, WorkPlane } from "../../geometry/plane";
import { Vec3 } from "../../math/vec";
import { ICurve, intersect, paramOf, pointAt } from "../geometry/intersect";
import { ProjectedCurve } from "../geometry/project";

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

const CONSTRUCTION_SCHEMA: JSONSchema = {
  type: "boolean",
  description: "Construction (reference) geometry: drawn dashed and excluded from filled profiles / extrusion.",
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
        name: { type: "string", description: "Optional sketch name." },
      },
    },
    examples: [
      { note: "Sketch on the front plane", params: { plane: "XZ" } },
      { note: "Sketch 20mm above XY", params: { plane: "XY", offset: 20 } },
      { note: "Sketch on a datum plane", params: { datum: "pl5" } },
    ],
    apply(draft, p: { plane?: string; offset?: number; datum?: string; planeDef?: { origin: Vec3; normal: Vec3 }; name?: string }, ctx) {
      const sid = ctx.alloc("sketch");
      const originId = ctx.alloc("pt");
      const count = Object.keys(draft.sketches).length + 1;
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
        originPointId: originId,
        entities: { [originId]: origin },
        constraints: {},
        status: { dof: 0, fullyConstrained: false, converged: true, conflicting: false },
      };
      draft.components[draft.rootComponentId].sketches.push(sid);
      return { createdIds: [sid, originId], affectedSketchId: sid, message: `Created ${draft.sketches[sid].name}` };
    },
  },
  {
    type: "plane.create",
    title: "Offset plane",
    summary: "Create a reusable datum plane offset from a base plane.",
    description:
      "Creates a parametric datum/reference plane offset from a base plane (an origin plane XY/XZ/YZ or another datum plane id) by `offset` along its normal. Reusable: sketch on it with sketch.create {datum: <id>}, and editing the offset propagates to everything built on it. Returns the plane id.",
    paramsSchema: {
      type: "object",
      required: ["base", "offset"],
      additionalProperties: false,
      properties: {
        base: { type: "string", description: "Base plane: XY/XZ/YZ or a datum plane id." },
        offset: { type: "string", description: "Offset distance expression, e.g. '20' or 'height/2'." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "A plane 25mm above XY", params: { base: "XY", offset: "25" } }],
    apply(draft, p: { base: string; offset: string | number; name?: string }, ctx) {
      if (!["XY", "XZ", "YZ"].includes(p.base) && !draft.planes[p.base]) throw new Error(`No base plane "${p.base}"`);
      const id = ctx.alloc("pl");
      const count = Object.keys(draft.planes).length + 1;
      draft.planes[id] = {
        id,
        name: p.name ?? `Plane ${count}`,
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
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    examples: [
      { note: "From origin to (60,0)", params: { sketch: "sketch1", start: { ref: "pt2" }, end: { x: 60, y: 0 } } },
    ],
    apply(draft, p: { sketch: string; start: PointRef; end: PointRef; construction?: boolean }, ctx) {
      const sk = sketchOf(draft, p.sketch);
      const a = resolvePoint(sk, p.start, ctx);
      const b = resolvePoint(sk, p.end, ctx);
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
      const c = resolvePoint(sk, p.center, ctx);
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
      const c = resolvePoint(sk, p.center, ctx);
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
      "Creates a rectangle between two opposite corners, as 4 coincident lines, and applies 2 horizontal + 2 vertical constraints so it stays rectangular. Returns the 4 corner point ids.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "corner", "opposite"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        corner: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        opposite: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
        construction: CONSTRUCTION_SCHEMA,
      },
    },
    apply(
      draft,
      p: { sketch: string; corner: { x: number; y: number }; opposite: { x: number; y: number }; construction?: boolean },
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
      "Creates a rectangle: p1→p2 is one edge; p3 sets the perpendicular width. Adds perpendicular constraints so it stays rectangular. Returns the 4 corner ids.",
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
      return { createdIds: [c0, c1, c2, c3], affectedSketchId: sk.id, message: "Rectangle" };
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
      const c = resolvePoint(sk, p.center, ctx);
      const s = resolvePoint(sk, p.start, ctx);
      const e = resolvePoint(sk, p.end, ctx);
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
      "`operation` combines the result with existing bodies, Fusion-style: \"new\" (default) makes a separate body, \"join\" fuses it into the most recent body, \"cut\" subtracts it. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["sketch", "distance"],
      additionalProperties: false,
      properties: {
        sketch: { type: "string" },
        distance: { type: "string", description: "Distance expression, e.g. '10' or 'height*2'." },
        symmetric: { type: "boolean", description: "Extrude symmetrically about the plane." },
        operation: { type: "string", enum: ["new", "join", "cut"], description: "Combine with existing bodies: new (default), join, or cut." },
        region: {
          type: "object",
          description: "A point inside the region to extrude (sketch u,v). Omit to extrude every region.",
          required: ["x", "y"],
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        name: { type: "string" },
      },
    },
    examples: [
      { note: "Extrude sketch1 by the `height` parameter", params: { sketch: "sketch1", distance: "height" } },
      { note: "Join a boss onto the current body", params: { sketch: "sketch3", distance: "6", operation: "join" } },
    ],
    apply(draft, p: { sketch: string; distance: string | number; symmetric?: boolean; operation?: "new" | "join" | "cut"; region?: { x: number; y: number }; name?: string }, ctx) {
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
        operation: p.operation ?? "new",
        regionPoint: p.region,
      };
      return { createdIds: [id], message: `Extrude ${p.sketch}` };
    },
  },
  {
    type: "feature.mirror",
    title: "Mirror bodies",
    summary: "Reflect the model across a plane and fuse the reflection in (symmetry).",
    description:
      "Reflects every existing body across a plane and fuses each reflection into its source body, giving a symmetric result. `plane` is an origin plane (XY/XZ/YZ) or a datum plane id (from plane.create). Parametric: editing the upstream geometry re-mirrors. Returns the feature id.",
    paramsSchema: {
      type: "object",
      required: ["plane"],
      additionalProperties: false,
      properties: {
        plane: { type: "string", description: "Mirror plane: XY/XZ/YZ or a datum plane id." },
        name: { type: "string" },
      },
    },
    examples: [{ note: "Mirror the model across the YZ plane", params: { plane: "YZ" } }],
    apply(draft, p: { plane: string; name?: string }, ctx) {
      if (!["XY", "XZ", "YZ"].includes(p.plane) && !draft.planes[p.plane]) throw new Error(`No mirror plane "${p.plane}"`);
      const id = ctx.alloc("mir");
      draft.features[id] = { id, kind: "mirror", name: p.name ?? "Mirror", plane: p.plane };
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

type Vec = { x: number; y: number };

/** Copy entities, mapping each point through `tf`. Shared by the pattern tools. */
function copyEntities(sk: Sketch, ids: string[], ctx: CommandContext, tf: (p: Vec) => Vec): string[] {
  const map = new Map<string, string>();
  const mp = (id: string): string => {
    if (map.has(id)) return map.get(id)!;
    const o = sk.entities[id] as SketchPoint;
    const t = tf({ x: o.x, y: o.y });
    const nid = ctx.alloc("pt");
    sk.entities[nid] = { id: nid, kind: "point", x: t.x, y: t.y, construction: o.construction };
    map.set(id, nid);
    return nid;
  };
  const created: string[] = [];
  for (const eid of ids) {
    const e = sk.entities[eid];
    if (!e) continue;
    if (e.kind === "point") created.push(mp(eid));
    else if (e.kind === "line") { const nid = ctx.alloc("ln"); sk.entities[nid] = { id: nid, kind: "line", p1: mp(e.p1), p2: mp(e.p2), construction: e.construction }; created.push(nid); }
    else if (e.kind === "circle") { const nid = ctx.alloc("ci"); sk.entities[nid] = { id: nid, kind: "circle", center: mp(e.center), r: e.r, construction: e.construction }; created.push(nid); }
    else if (e.kind === "arc") { const nid = ctx.alloc("ar"); sk.entities[nid] = { id: nid, kind: "arc", center: mp(e.center), p1: mp(e.p1), p2: mp(e.p2), r: e.r, ccw: e.ccw, construction: e.construction }; created.push(nid); }
  }
  return created;
}

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

const TAU = Math.PI * 2;
const normAng = (a: number) => ((a % TAU) + TAU) % TAU;

function extendCurve(sk: Sketch, targetId: string, u: number, v: number): CommandApplyInfo {
  const tgt = sk.entities[targetId];
  if (!tgt || (tgt.kind !== "line" && tgt.kind !== "arc")) throw new Error("extend works on lines and arcs");
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const click = { x: u, y: v };
  const others = Object.values(sk.entities).filter((e) => e.id !== targetId && e.kind !== "point");
  const dist = (p: Vec, q: Vec) => Math.hypot(p.x - q.x, p.y - q.y);
  const EPS = 1e-4;

  if (tgt.kind === "line") {
    const a = P(tgt.p1), b = P(tgt.p2);
    const endIsB = dist(click, b) <= dist(click, a);
    const dir = { x: b.x - a.x, y: b.y - a.y };
    const dl = Math.hypot(dir.x, dir.y) || 1; dir.x /= dl; dir.y /= dl;
    const BIG = 1e5;
    const longLine: ICurve = { kind: "line", a: { x: a.x - dir.x * BIG, y: a.y - dir.y * BIG }, b: { x: b.x + dir.x * BIG, y: b.y + dir.y * BIG } };
    const orig: ICurve = { kind: "line", a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    let bestT: number | null = null;
    for (const o of others) {
      const oc = toICurve(sk, o as any); if (!oc) continue;
      for (const pt of intersect(longLine, oc)) {
        const t = paramOf(orig, pt);
        if (endIsB && t > 1 + EPS) { if (bestT === null || t < bestT) bestT = t; }
        else if (!endIsB && t < -EPS) { if (bestT === null || t > bestT) bestT = t; }
      }
    }
    if (bestT === null) throw new Error("nothing to extend to in that direction");
    const np = pointAt(orig, bestT);
    const ep = endIsB ? P(tgt.p2) : P(tgt.p1);
    ep.x = np.x; ep.y = np.y;
    return { affectedSketchId: sk.id, message: "Extended" };
  }

  // arc
  const c = P(tgt.center), s = P(tgt.p1), e = P(tgt.p2);
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  const endIsEnd = dist(click, e) <= dist(click, s);
  const full: ICurve = { kind: "circle", c: { x: c.x, y: c.y }, r: (tgt as any).r };
  let best: { ang: number; d: number } | null = null;
  for (const o of others) {
    const oc = toICurve(sk, o as any); if (!oc) continue;
    for (const pt of intersect(full, oc)) {
      const ang = Math.atan2(pt.y - c.y, pt.x - c.x);
      let d: number;
      if (endIsEnd) d = tgt.ccw ? normAng(ang - a1) : normAng(a1 - ang);
      else d = tgt.ccw ? normAng(a0 - ang) : normAng(ang - a0);
      if (d > EPS && (best === null || d < best.d)) best = { ang, d };
    }
  }
  if (!best) throw new Error("nothing to extend to");
  const np = { x: c.x + (tgt as any).r * Math.cos(best.ang), y: c.y + (tgt as any).r * Math.sin(best.ang) };
  const ep = endIsEnd ? P(tgt.p2) : P(tgt.p1);
  ep.x = np.x; ep.y = np.y;
  return { affectedSketchId: sk.id, message: "Extended" };
}

function offsetCurve(sk: Sketch, targetId: string, d: number, ctx: CommandContext): CommandApplyInfo {
  const tgt = sk.entities[targetId];
  if (!tgt || tgt.kind === "point") throw new Error("offset works on a line, circle or arc");
  const P = (id: string) => sk.entities[id] as SketchPoint;
  const mkPt = (x: number, y: number): string => { const id = ctx.alloc("pt"); sk.entities[id] = { id, kind: "point", x, y }; return id; };

  if (tgt.kind === "line") {
    const a = P(tgt.p1), b = P(tgt.p2);
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const p1 = mkPt(a.x + nx * d, a.y + ny * d);
    const p2 = mkPt(b.x + nx * d, b.y + ny * d);
    const id = ctx.alloc("ln");
    sk.entities[id] = { id, kind: "line", p1, p2, construction: tgt.construction };
    return { createdIds: [id, p1, p2], affectedSketchId: sk.id, message: "Offset line" };
  }
  if (tgt.kind === "circle") {
    const c = P(tgt.center);
    const r = tgt.r + d;
    if (r <= 1e-6) throw new Error("offset distance collapses the circle");
    const ctr = mkPt(c.x, c.y);
    const id = ctx.alloc("ci");
    sk.entities[id] = { id, kind: "circle", center: ctr, r, construction: tgt.construction };
    return { createdIds: [id, ctr], affectedSketchId: sk.id, message: "Offset circle" };
  }
  // arc
  if (tgt.kind !== "arc") throw new Error("offset supports lines, circles and arcs");
  const c = P(tgt.center), s = P(tgt.p1), e = P(tgt.p2);
  const r = tgt.r + d;
  if (r <= 1e-6) throw new Error("offset distance collapses the arc");
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  const ctr = mkPt(c.x, c.y);
  const p1 = mkPt(c.x + r * Math.cos(a0), c.y + r * Math.sin(a0));
  const p2 = mkPt(c.x + r * Math.cos(a1), c.y + r * Math.sin(a1));
  const id = ctx.alloc("ar");
  sk.entities[id] = { id, kind: "arc", center: ctr, p1, p2, r, ccw: (tgt as any).ccw, construction: tgt.construction };
  return { createdIds: [id, ctr, p1, p2], affectedSketchId: sk.id, message: "Offset arc" };
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
