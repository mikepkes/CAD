// Motion study: sweep a model's revolute joints through a full turn and check
// that nothing collides. Each driven joint (a revolute joint whose motion value
// is a bare parameter) is swept 0..360° independently; at each pose the geometry
// backend measures body-body interpenetration. Any real overlap — or a build
// that fails ("crash") — fails the study, so a customize-mode slider value that
// would jam or break the mechanism can be flagged.

import { CadDocument } from "../core/document";
import { GeometryBackend } from "../core/geometry/backend";

const BARE_PARAM = /^[a-zA-Z_]\w*$/;

/** The driven joint parameters to sweep — each revolute joint whose value is a
 *  single parameter (so sweeping that parameter drives exactly that joint). */
export function driveParams(doc: CadDocument): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const j of Object.values(doc.joints)) {
    if (j.kind !== "revolute") continue;
    const expr = (j.valueExpr ?? "").trim();
    if (BARE_PARAM.test(expr) && doc.parameters.some((p) => p.name === expr) && !seen.has(expr)) {
      seen.add(expr); out.push(expr);
    }
  }
  return out;
}

export type MotionStatus = "idle" | "running" | "pass" | "fail";

export interface MotionResult {
  status: "pass" | "fail";
  /** Human-readable cause of a failure. */
  reason?: string;
  /** Largest interpenetration seen (mm³). */
  worstOverlap: number;
}

export interface MotionStudyOptions {
  steps?: number;            // samples per joint over 360° (default 12 → every 30°)
  overlapTolerance?: number; // mm³ above which an overlap fails (default 1)
  onProgress?: (fraction: number) => void;
  cancelled?: () => boolean;
}

/** Sweep each driven joint through 360° (the others held at 0) and pass/fail on
 *  collision or a build error. Returns `null` if cancelled. */
export async function runMotionStudy(
  backend: GeometryBackend,
  doc: CadDocument,
  opts: MotionStudyOptions = {},
): Promise<MotionResult | null> {
  const steps = opts.steps ?? 12;
  const tol = opts.overlapTolerance ?? 1;
  const joints = driveParams(doc);
  if (!joints.length) return { status: "pass", worstOverlap: 0 }; // nothing to move
  const total = joints.length * steps;
  let done = 0;
  let worst = 0;
  for (const j of joints) {
    for (let k = 0; k < steps; k++) {
      if (opts.cancelled?.()) return null;
      const angle = (360 * k) / steps;
      const overrides: Record<string, string> = { [j]: String(angle) };
      for (const other of joints) if (other !== j) overrides[other] = "0";
      let res;
      try {
        res = await backend.collide(doc, overrides);
      } catch (e) {
        return { status: "fail", reason: `crash at ${j} = ${Math.round(angle)}°: ${(e as Error).message}`, worstOverlap: worst };
      }
      done++; opts.onProgress?.(done / total);
      if (res.buildError) {
        return { status: "fail", reason: `build error at ${j} = ${Math.round(angle)}°: ${res.buildError}`, worstOverlap: worst };
      }
      worst = Math.max(worst, res.maxOverlap);
      if (res.maxOverlap > tol) {
        const pair = [...res.overlaps].sort((a, b) => b.volume - a.volume)[0];
        const where = pair ? `${pair.a} hits ${pair.b}` : "parts overlap";
        return { status: "fail", reason: `${where} at ${j} = ${Math.round(angle)}°`, worstOverlap: worst };
      }
    }
  }
  return { status: "pass", worstOverlap: worst };
}
