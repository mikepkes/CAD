// Splitting one evaluation across a pool of geometry workers, and putting the answers back
// together. Environment-agnostic (no Worker here): the plan says which worker builds which
// features, the merge turns the workers' rows into the rows a whole evaluation would have
// given, in the same order. The worker backend (model/worker-backend.ts) does the posting.

import type { CadDocument, FeatureDef } from "../document";
import type { Scope } from "../../math/expr";
import type { WorkPlane } from "../../geometry/plane";
import type { SolidEval } from "../features";
import { featureChains, featureOrder, type FeatureChain } from "./chains";
import { featureActive } from "../features";

export interface EvaluationPart {
  /** Which worker of the pool builds it. */
  worker: number;
  /** The features it builds (whole chains), in timeline order. */
  only: string[];
}

/**
 * Which worker builds which features, for a pool of `size` workers — or null when the
 * evaluation is not worth splitting (one worker, or the model is one chain, or its
 * chains can't be told apart safely): then worker 0 builds it whole, as before.
 *
 * A chain stays on the worker `placed` (the backend's memory of earlier plans) gives
 * it, so that worker's incremental cache keeps hitting for it. A chain not placed yet
 * — every chain, on the first build — goes to the least loaded worker, the heaviest
 * first (by featureWeight), so a chain that takes seconds (a long modelled thread, a
 * herringbone gear) gets a worker to itself rather than a share of the others' work
 * too; the plan is the same for the same model and `placed`.
 */
export function planEvaluation(doc: CadDocument, scope: Scope, size: number, placed = new Map<string, number>()): EvaluationPart[] | null {
  if (size < 2) return null;
  const chains = featureChains(doc, scope);
  if (!chains || chains.length < 2) return null;
  const weight = new Map(chains.map((c) => [c.id, c.features.reduce((a, id) => a + featureWeight(doc.features[id]), 0)]));
  const loads = new Array<number>(size).fill(0);
  const parts: EvaluationPart[] = Array.from({ length: size }, (_, worker) => ({ worker, only: [] }));
  const put = (c: FeatureChain, w: number) => { loads[w] += weight.get(c.id)!; parts[w].only.push(...c.features); placed.set(c.id, w); };
  const fresh: FeatureChain[] = [];
  for (const c of chains) {
    const w = placed.get(c.id);
    if (w !== undefined && w < size) put(c, w); else fresh.push(c);
  }
  for (const c of fresh.sort((a, b) => weight.get(b.id)! - weight.get(a.id)! || (a.id < b.id ? -1 : 1))) put(c, loads.indexOf(Math.min(...loads)));
  const order = featureOrder(doc);
  for (const p of parts) p.only.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return parts.filter((p) => p.only.length);
}

/** Roughly what a feature costs to build, in plain extrudes (tens of ms): enough to tell the
 *  chains that take seconds from the rest when they are shared out (measured with
 *  scripts/bench/profile.ts: a modelled thread ~10 per turn, a gear 20–80, a sweep ~10–30). */
export function featureWeight(f: FeatureDef | undefined): number {
  switch (f?.kind) {
    case "thread": return f.spec.representation === "modeled" ? 10 * Math.max(1, f.spec.length / Math.max(0.1, f.spec.pitch)) : 1;
    case "gear": return f.gearType === "spur" || f.gearType === "rack" ? 20 : 40;
    case "sweep": case "loft": return 10;
    case "voronoi": return 20;
    case "fillet": case "chamfer": case "shell": return 3;
    default: return 1;
  }
}

export interface PartResult {
  solids: Record<string, SolidEval>;
  facePlanes?: Record<string, WorkPlane>;
  /** The rows the part's feature steps wrote before its bodies' rows (see StagedEvaluation.applied). */
  applied?: string[];
}

/**
 * The parts' rows as one evaluation's, in the order a whole evaluation writes them: the
 * rows the feature steps wrote (in timeline order), then the bodies' rows (in the order
 * the bodies were made, which is their makers' timeline order).
 */
export function mergeParts(doc: CadDocument, parts: PartResult[]): { solids: Record<string, SolidEval>; facePlanes: Record<string, WorkPlane> } {
  const order = featureOrder(doc);
  // a row's feature: its key, or the key's feature prefix (a weldment's `member/gusset1`)
  const at = (key: string) => order.get(key) ?? order.get(key.split(/[/:]/)[0]) ?? Number.MAX_SAFE_INTEGER;
  const rows: { key: string; row: SolidEval; sort: [number, number, number, number] }[] = [];
  const facePlanes: Record<string, WorkPlane> = {};
  parts.forEach((p, pi) => {
    const early = new Set(p.applied ?? []);
    Object.entries(p.solids).forEach(([key, row], li) => rows.push({ key, row, sort: [early.has(key) ? 0 : 1, at(key), pi, li] }));
    Object.assign(facePlanes, p.facePlanes ?? {});
  });
  rows.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2] || a.sort[3] - b.sort[3]);
  return { solids: Object.fromEntries(rows.map((r) => [r.key, r.row])), facePlanes };
}

/**
 * Whether the split's answer can be trusted: a feature that failed to make its body
 * changes what "the most recent body" means to the features after it — the whole
 * evaluation would fold them into an earlier body, the split part had none. When a part
 * reports such an error and the model has a feature that names no body, build it whole.
 */
export function needsWholeRebuild(doc: CadDocument, scope: Scope, solids: Record<string, SolidEval>): boolean {
  if (!Object.values(solids).some((r) => r.error)) return false;
  return hasImplicitTargets(doc, scope);
}

/** Whether any active modifier picks its body by recency rather than by name. */
export function hasImplicitTargets(doc: CadDocument, scope: Scope): boolean {
  for (const f of Object.values(doc.features)) {
    if (!featureActive(f, scope)) continue;
    if (f.kind === "mirror") return true;
    const op = "operation" in f ? (f.operation ?? "new") : "new";
    const modifies = ["hole", "fillet", "chamfer", "shell", "pattern", "voronoi", "trim", "thread"].includes(f.kind) || op !== "new";
    if (modifies && !("body" in f && f.body && f.body !== "last")) return true;
  }
  return false;
}
