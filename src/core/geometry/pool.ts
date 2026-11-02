// Splitting one evaluation across a pool of geometry workers, and putting the answers back
// together. Environment-agnostic (no Worker here): the plan says which worker builds which
// features, the merge turns the workers' rows into the rows a whole evaluation would have
// given, in the same order. The worker backend (model/worker-backend.ts) does the posting.

import type { CadDocument } from "../document";
import type { Scope } from "../../math/expr";
import type { WorkPlane } from "../../geometry/plane";
import type { SolidEval } from "../features";
import { featureChains, featureOrder } from "./chains";
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
 * A chain always goes to the same worker (by a hash of its id), so that worker's
 * incremental cache keeps hitting for it; the hash slot is only overridden when it is
 * fuller than its share, so a few chains still spread over the pool.
 */
export function planEvaluation(doc: CadDocument, scope: Scope, size: number): EvaluationPart[] | null {
  if (size < 2) return null;
  const chains = featureChains(doc, scope);
  if (!chains || chains.length < 2) return null;
  const cap = Math.ceil(chains.length / size);
  const loads = new Array<number>(size).fill(0);
  const parts: EvaluationPart[] = Array.from({ length: size }, (_, worker) => ({ worker, only: [] }));
  // by hash order, so the same chains always get the same slots whatever the timeline's order
  for (const c of [...chains].sort((a, b) => hash(a.id) - hash(b.id) || (a.id < b.id ? -1 : 1))) {
    let w = hash(c.id) % size;
    for (let k = 0; k < size && loads[w] >= cap; k++) w = (w + 1) % size;
    loads[w]++;
    parts[w].only.push(...c.features);
  }
  const order = featureOrder(doc);
  for (const p of parts) p.only.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return parts.filter((p) => p.only.length);
}

/** FNV-1a, so a chain's slot is the same in every session. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
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
    const modifies = ["hole", "fillet", "chamfer", "shell", "pattern", "trim", "thread"].includes(f.kind) || op !== "new";
    if (modifies && !("body" in f && f.body && f.body !== "last")) return true;
  }
  return false;
}
