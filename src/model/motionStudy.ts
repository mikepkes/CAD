// Motion study: sweep a model's revolute joints through a full turn and check
// that nothing collides. Each driven joint (a revolute joint whose motion value
// is a bare parameter) is swept 0..360° independently; at each pose the geometry
// backend measures body-body interpenetration. Any real overlap — or a build
// that fails ("crash") — fails the study, so a customize-mode slider value that
// would jam or break the mechanism can be flagged.
//
// It runs coarse first: a few poses spread round the turn (a jam usually shows
// there, and fails at once), then the poses between them. A study can take
// minutes on a big model (a clockwork's gear train), so the viewer shows the
// coarse result while the rest runs, an estimate of the time left, and keeps
// verdicts per set of parameter values (motionKey) so a value seen before
// answers at once.

import { CadDocument, Joint } from "../core/document";
import { GeometryBackend } from "../core/geometry/backend";

const BARE_PARAM = /^[a-zA-Z_]\w*$/;

/** The driven joint parameters to sweep — each revolute joint whose value is a
 *  single parameter (so sweeping that parameter drives exactly that joint). */
export function driveParams(doc: CadDocument): string[] {
  return driveJoints(doc).map((d) => d.param);
}

/** The driven joints, with the kind of motion each makes. */
export function driveJoints(doc: CadDocument): { param: string; kind: Joint["kind"] }[] {
  const seen = new Set<string>();
  const out: { param: string; kind: Joint["kind"] }[] = [];
  for (const j of Object.values(doc.joints)) {
    if (j.kind !== "revolute") continue;
    const expr = (j.valueExpr ?? "").trim();
    if (BARE_PARAM.test(expr) && doc.parameters.some((p) => p.name === expr) && !seen.has(expr)) {
      seen.add(expr); out.push({ param: expr, kind: j.kind });
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
  /** Poses per joint in the first, coarse pass (default 4: every 90°); the rest follow. */
  coarse?: number;
  overlapTolerance?: number; // mm³ above which an overlap fails (default 1)
  onProgress?: (fraction: number) => void;
  /** The coarse pass came through clear (`checked` poses of `total`); the poses between follow. */
  onCoarseClear?: (checked: number, total: number) => void;
  cancelled?: () => boolean;
}

/** The order the poses are checked in: indices into an even `steps`-pose turn, a
 *  coarse `coarse` of them spread round it first, then the ones between. */
export function sampleOrder(steps: number, coarse: number): { first: number[]; rest: number[] } {
  const n = Math.max(1, Math.min(coarse, steps));
  const first = [...new Set(Array.from({ length: n }, (_, i) => Math.round((i * steps) / n) % steps))];
  const rest = Array.from({ length: steps }, (_, k) => k).filter((k) => !first.includes(k));
  return { first, rest };
}

/** The key a verdict is kept under: the design and every parameter's expression
 *  except the swept drives' own (the study poses those itself). */
export function motionKey(doc: CadDocument): string {
  const drives = new Set(driveParams(doc));
  return JSON.stringify([doc.id, doc.activeConfiguration ?? null, doc.parameters.filter((p) => !drives.has(p.name)).map((p) => [p.name, p.expr])]);
}

/** A verdict in words, by the kind of motion checked: "Turns a full circle with
 *  nothing in the way", or what hit what, and where. */
export function motionVerdict(doc: CadDocument, res: MotionResult): string {
  if (res.status === "fail") return res.reason ?? "Parts collide";
  const drives = driveJoints(doc);
  const label = (n: string) => doc.parameters.find((p) => p.name === n)?.label;
  const kinds = new Set(drives.map((d) => d.kind));
  // [one joint, several joints]
  const [one, many] = kinds.size === 1 && kinds.has("revolute") ? ["turns a full circle", "turn a full circle"]
    : kinds.size === 1 && (kinds.has("slider") || kinds.has("pin-slot")) ? ["slides its full travel", "slide their full travel"]
    : ["moves through its full range", "move through their full range"];
  const free = "with nothing in the way";
  if (drives.length > 1) return `All ${drives.length} joints ${many} ${free}`;
  const l = drives[0] && label(drives[0].param);
  return l ? `${l} ${one} ${free}` : `${one[0].toUpperCase()}${one.slice(1)} ${free}`;
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
  const called = (n: string) => doc.parameters.find((p) => p.name === n)?.label || n;
  const total = joints.length * steps;
  const { first, rest } = sampleOrder(steps, opts.coarse ?? 4);
  let done = 0;
  let worst = 0;
  const pose = async (j: string, k: number): Promise<MotionResult | null | undefined> => {
    if (opts.cancelled?.()) return null;
    const angle = (360 * k) / steps;
    const overrides: Record<string, string> = { [j]: String(angle) };
    for (const other of joints) if (other !== j) overrides[other] = "0";
    let res;
    try {
      res = await backend.collide(doc, overrides);
    } catch (e) {
      return { status: "fail", reason: `crash at ${called(j)} = ${Math.round(angle)}°: ${(e as Error).message}`, worstOverlap: worst };
    }
    done++; opts.onProgress?.(done / total);
    if (res.buildError) {
      return { status: "fail", reason: `build error at ${called(j)} = ${Math.round(angle)}°: ${res.buildError}`, worstOverlap: worst };
    }
    worst = Math.max(worst, res.maxOverlap);
    if (res.maxOverlap > tol) {
      const pair = [...res.overlaps].sort((a, b) => b.volume - a.volume)[0];
      const where = pair ? `${pair.a} hits ${pair.b}` : "parts overlap";
      return { status: "fail", reason: `${where} at ${called(j)} = ${Math.round(angle)}°`, worstOverlap: worst };
    }
    return undefined; // clear
  };
  for (const pass of [first, rest]) {
    for (const j of joints) {
      for (const k of pass) {
        const r = await pose(j, k);
        if (r !== undefined) return r;
      }
    }
    if (pass === first && rest.length) opts.onCoarseClear?.(done, total);
  }
  return { status: "pass", worstOverlap: worst };
}
