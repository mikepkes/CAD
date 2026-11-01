// Shared test helpers: build a real CadSession on the pure core + PlaneGCS.

import { CadSession } from "../src/core/command/session";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { createDocument } from "../src/core/document";
import { PlaneGCSSolver } from "../src/core/solver/planegcs";
import { ConstraintSolver, SolveResult, SolverModel } from "../src/core/solver/model";
import { deserializeDocument } from "../src/core/persistence";
import type { CadDocument } from "../src/core/document";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ---- the default and the extended run (see vitest.config.ts, README: Testing) ----

/** True in the extended run (`npm run test:full`, or VIBECAD_TEST_FULL=1). */
export const FULL = process.env.VIBECAD_TEST_FULL === "1";
/** A test that only runs in the extended run: a slow sweep (materials, slider
 *  corners, poses) whose default-run counterpart is a lighter check elsewhere. */
export const itFull = it.runIf(FULL);
/** A suite that only runs in the extended run. */
export const describeFull = describe.runIf(FULL);

/** A copy of a built session to change (set parameters, …) without touching the
 *  original: building a generator's model once per file and forking it per test
 *  is much cheaper than replaying hundreds of commands for every test. */
export async function forkSession(s: CadSession): Promise<CadSession> {
  const f = sessionFromDoc(structuredClone(s.doc));
  await f.recompute();
  return f;
}

/** A document's recipe, for comparing a generator's output with its committed
 *  example: every operation's type, parameters and ids, and what is hidden (not
 *  the document id, the timestamps or the commands' labels). */
function recipeOf(doc: CadDocument) {
  return {
    nextId: doc.nextId,
    rollbackIndex: doc.rollbackIndex,
    operations: doc.operations.map((o) => ({ type: o.type, params: o.params, createdIds: o.createdIds, ...(o.suppressed ? { suppressed: true } : {}) })),
    hidden: doc.hidden ?? [],
  };
}

/**
 * The generator built exactly the committed example `public/examples/<name>.json`.
 * The example suite (test/exampleSuite.ts) builds, snapshots and collision-checks
 * the committed example on both geometry paths; this ties the generator to it, so
 * a generator test needn't build and collide the same model again. When it fails
 * on purpose, regenerate the example with the generator's BUILD_* variable.
 */
export function expectCommittedExample(s: CadSession, name: string): void {
  const committed = deserializeDocument(readFileSync(fileURLToPath(new URL(`../public/examples/${name}.json`, import.meta.url)), "utf8"));
  // as saved: through JSON, as the committed file was (which, for one, writes −0 as 0)
  const a = JSON.parse(JSON.stringify(recipeOf(s.doc))) as ReturnType<typeof recipeOf>, b = recipeOf(committed);
  const at = a.operations.findIndex((o, i) => JSON.stringify(o) !== JSON.stringify(b.operations[i]));
  expect(at, `public/examples/${name}.json differs from its generator from operation ${at} (${a.operations[at]?.type}): regenerate it`).toBe(-1);
  expect(a).toEqual(b);
}
