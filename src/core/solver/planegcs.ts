// PlaneGCS (FreeCAD's 2D geometric constraint solver) adapter.
//
// Implements the neutral ConstraintSolver interface by translating a
// SolverModel into PlaneGCS primitives/constraints, solving, and reading back
// solved coordinates plus the DoF / conflict / redundancy diagnosis. Each
// constraint keeps our id, so conflicts are reported back by our ids — which is
// what lets us point a user or agent at exactly what over-constrains.

import type { GcsWrapper } from "@salusoft89/planegcs";
import {
  ConstraintSolver,
  SolveResult,
  SolverModel,
  SolverConstraint,
  SolveStatusCode,
} from "./model";
import { TAU } from "../units";

export interface PlaneGCSOptions {
  /** URL of planegcs.wasm (required in the browser; omit in Node). */
  wasmUrl?: string;
}

// PlaneGCS sketch primitive/constraint objects are loosely typed here; the
// wrapper validates them. Keeping this local avoids leaking PlaneGCS types.
type GcsObject = Record<string, unknown> & { id: string; type: string };

export class PlaneGCSSolver implements ConstraintSolver {
  readonly name = "PlaneGCS";
  private wrapper: GcsWrapper | null = null;
  private readyPromise: Promise<void> | null = null;
  private opts: PlaneGCSOptions;

  constructor(opts: PlaneGCSOptions = {}) {
    this.opts = opts;
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const mod = await import("@salusoft89/planegcs");
        // Initialise the module ourselves so we can silence emscripten's
        // stdout/stderr — essential when the core drives an MCP stdio server,
        // whose stdout is the protocol channel.
        const options: Record<string, unknown> = {
          print: () => {},
          printErr: () => {},
        };
        if (this.opts.wasmUrl) options.locateFile = () => this.opts.wasmUrl;
        const module = await mod.init_planegcs_module(options as never);
        const gcs = new module.GcsSystem();
        this.wrapper = new mod.GcsWrapper(gcs, module);
        try {
          (this.wrapper as unknown as { debug_mode: number }).debug_mode = 0;
        } catch {
          /* ignore */
        }
      })();
    }
    return this.readyPromise;
  }

  dispose(): void {
    try {
      this.wrapper?.destroy_gcs_module();
    } catch {
      /* ignore */
    }
    this.wrapper = null;
    this.readyPromise = null;
  }

  async solve(model: SolverModel): Promise<SolveResult> {
    await this.ready();
    const w = this.wrapper!;
    w.clear_data();

    const objects: GcsObject[] = [];

    for (const p of model.points) {
      objects.push({ id: p.id, type: "point", x: p.x, y: p.y, fixed: p.fixed });
    }
    for (const l of model.lines) {
      objects.push({ id: l.id, type: "line", p1_id: l.p1, p2_id: l.p2 });
    }
    for (const c of model.circles) {
      objects.push({ id: c.id, type: "circle", c_id: c.center, radius: c.r });
    }
    const pointById = new Map(model.points.map((p) => [p.id, p]));
    for (const a of model.arcs) {
      const ctr = pointById.get(a.center)!;
      const s = pointById.get(a.start)!;
      const e = pointById.get(a.end)!;
      const startAngle = Math.atan2(s.y - ctr.y, s.x - ctr.x);
      const endAngle = Math.atan2(e.y - ctr.y, e.x - ctr.x);
      objects.push({
        id: a.id,
        type: "arc",
        c_id: a.center,
        start_id: a.start,
        end_id: a.end,
        radius: a.r,
        start_angle: startAngle,
        end_angle: endAngle,
      });
      objects.push({ id: `${a.id}~rules`, type: "arc_rules", a_id: a.id });
    }

    for (const c of model.constraints) {
      const mapped = this.mapConstraint(c);
      if (mapped) objects.push(mapped);
    }

    // push_primitives_and_params resolves ids in array order, so geometry must
    // precede the constraints that reference it (it does, above).
    w.push_primitives_and_params(objects as never);

    const status = w.solve();
    w.apply_solution();

    const points: Record<string, { x: number; y: number }> = {};
    for (const p of model.points) {
      const sp = w.sketch_index.get_sketch_point(p.id);
      points[p.id] = { x: sp.x, y: sp.y };
    }
    const radii: Record<string, number> = {};
    for (const c of model.circles) {
      radii[c.id] = w.sketch_index.get_sketch_circle(c.id).radius;
    }
    for (const a of model.arcs) {
      radii[a.id] = w.sketch_index.get_sketch_arc(a.id).radius;
    }

    const dof = w.gcs.dof();
    const conflicting = w.get_gcs_conflicting_constraints();
    const redundant = w.get_gcs_redundant_constraints();
    const partiallyRedundant = w.get_gcs_partially_redundant_constraints();
    const hasConflict = w.gcs.has_conflicting();
    const hasRedundancy = w.gcs.has_redundant();

    const statusCode: SolveStatusCode =
      status === 0 || status === 1 ? "ok" : status === 3 ? "invalid" : "failed";

    return {
      status: statusCode,
      points,
      radii,
      diagnosis: {
        dof,
        fullyConstrained: dof === 0 && !hasConflict && statusCode === "ok",
        conflicting,
        redundant,
        partiallyRedundant,
        hasConflict,
        hasRedundancy,
      },
    };
  }

  private mapConstraint(c: SolverConstraint): GcsObject | null {
    switch (c.kind) {
      case "coincident":
        return { id: c.id, type: "p2p_coincident", p1_id: c.a, p2_id: c.b };
      case "horizontal":
        return { id: c.id, type: "horizontal_pp", p1_id: c.a, p2_id: c.b };
      case "vertical":
        return { id: c.id, type: "vertical_pp", p1_id: c.a, p2_id: c.b };
      case "parallel":
        return { id: c.id, type: "parallel", l1_id: c.l1, l2_id: c.l2 };
      case "perpendicular":
        return { id: c.id, type: "perpendicular_ll", l1_id: c.l1, l2_id: c.l2 };
      case "equalLength":
        return { id: c.id, type: "equal_length", l1_id: c.l1, l2_id: c.l2 };
      case "equalRadius":
        return { id: c.id, type: "equal_radius_cc", c1_id: c.c1, c2_id: c.c2 };
      case "pointOnLine":
        return { id: c.id, type: "point_on_line_pl", p_id: c.point, l_id: c.line };
      case "pointOnCircle":
        return { id: c.id, type: "point_on_circle", p_id: c.point, c_id: c.circle };
      case "symmetric":
        return { id: c.id, type: "p2p_symmetric_ppl", p1_id: c.a, p2_id: c.b, l_id: c.line };
      case "distance":
        return { id: c.id, type: "p2p_distance", p1_id: c.a, p2_id: c.b, distance: c.value };
      case "distanceX":
        // PlaneGCS `difference` enforces param2 - param1 = difference,
        // so param1=a, param2=b gives b.x - a.x = value.
        return {
          id: c.id,
          type: "difference",
          param1: { o_id: c.a, prop: "x" },
          param2: { o_id: c.b, prop: "x" },
          difference: c.value,
        };
      case "distanceY":
        return {
          id: c.id,
          type: "difference",
          param1: { o_id: c.a, prop: "y" },
          param2: { o_id: c.b, prop: "y" },
          difference: c.value,
        };
      case "radius":
        return { id: c.id, type: "circle_radius", c_id: c.circle, radius: c.value };
      case "diameter":
        return { id: c.id, type: "circle_diameter", c_id: c.circle, diameter: c.value };
      case "angle": {
        let a = c.value % TAU;
        if (a < 0) a += TAU;
        return { id: c.id, type: "l2l_angle_ll", l1_id: c.l1, l2_id: c.l2, angle: a };
      }
    }
  }
}
