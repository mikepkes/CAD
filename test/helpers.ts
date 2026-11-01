// Shared test helpers: build a real CadSession on the pure core + PlaneGCS.

import { CadSession } from "../src/core/command/session";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { createDocument } from "../src/core/document";
import { PlaneGCSSolver } from "../src/core/solver/planegcs";
import { ConstraintSolver, SolveResult, SolverModel } from "../src/core/solver/model";

/** A real session (PlaneGCS solves; no wasmUrl → emscripten finds the co-located wasm). */
export function realSession(): CadSession {
  return new CadSession(createDocument(), createDefaultRegistry(), new PlaneGCSSolver());
}

/** Wrap an existing (e.g. deserialized) document in a real session. */
export function sessionFromDoc(doc: ReturnType<typeof createDocument>): CadSession {
  return new CadSession(doc, createDefaultRegistry(), new PlaneGCSSolver());
}

/**
 * A deterministic no-op solver: echoes seed coordinates and reports fully
 * constrained. Lets the timeline/rebuild/propagation machinery be tested without
 * wasm, when the assertion is about document structure rather than solved values.
 */
export class EchoSolver implements ConstraintSolver {
  readonly name = "echo";
  async ready(): Promise<void> {}
  dispose(): void {}
  async solve(model: SolverModel): Promise<SolveResult> {
    const points: Record<string, { x: number; y: number }> = {};
    for (const p of model.points) points[p.id] = { x: p.x, y: p.y };
    const radii: Record<string, number> = {};
    for (const c of model.circles) radii[c.id] = c.r;
    for (const a of model.arcs) radii[a.id] = a.r;
    return {
      status: "ok",
      points,
      radii,
      diagnosis: { dof: 0, fullyConstrained: true, conflicting: [], redundant: [], partiallyRedundant: [], hasConflict: false, hasRedundancy: false },
    };
  }
}

export function echoSession(): CadSession {
  return new CadSession(createDocument(), createDefaultRegistry(), new EchoSolver());
}

/**
 * How an example reads in the customize viewer: its title and a line about it
 * (document.describe), and each control's label, unit and one-line description
 * (parameter.describe). Display only — no geometry, no ids — so an example's
 * snapshot doesn't move. The generators call it last.
 */
export async function describeExample(
  s: CadSession,
  about: { title: string; description: string },
  params: Record<string, { label: string; unit?: string; description?: string }>,
): Promise<void> {
  for (const [name, d] of Object.entries(params)) {
    const r = await s.dispatch("parameter.describe", { name, ...d });
    if (!r.ok) throw new Error(`parameter.describe ${name}: ${r.error}`);
  }
  const r = await s.dispatch("document.describe", about);
  if (!r.ok) throw new Error(`document.describe: ${r.error}`);
}
