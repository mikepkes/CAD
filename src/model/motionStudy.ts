// Motion study: sweep a model's driven joints through their range and check
// that nothing collides. Each drive (a joint motion value that is a bare
// parameter) is swept independently: an unlimited angle 0..360°, a limited one
// or a travel between its joint's stops; at each pose the geometry backend
// measures body-body interpenetration. Any real overlap — or a build that fails
// ("crash") — fails the study, so a customize-mode slider value that would jam
// or break the mechanism can be flagged. A joint a coupling drives follows its
// driver, so the parts it carries are checked through the coupling.
//
// It runs coarse first: a few poses spread round the turn (a jam usually shows
// there, and fails at once), then the poses between them. A study can take
// minutes on a big model (a clockwork's gear train), so the viewer shows the
// coarse result while the rest runs, an estimate of the time left, and keeps
// verdicts per design and set of parameter values (motionKey) so a value seen before
// answers at once.

import { CadDocument, Joint, JointDof, isAngularDof } from "../core/document";
import { GeometryBackend } from "../core/geometry/backend";
import { contentHash, stableJson } from "../core/contentKey";

const BARE_PARAM = /^[a-zA-Z_]\w*$/;

/** The driven joint parameters to sweep — each joint motion value that is a
 *  single parameter (so sweeping that parameter drives exactly that motion). */
export function driveParams(doc: CadDocument): string[] {
  return driveJoints(doc).map((d) => d.param);
}

/** One drive the study sweeps: the parameter, the kind of joint it moves, and
 *  how — a full turn (an angle without stops), or between `from` and `to` (a
 *  travel, or an angle with stops: `range`). */
export interface Drive {
  param: string;
  kind: Joint["kind"];
  motion: "turn" | "slide" | "range";
  from: number;
  to: number;
  unit: "°" | "mm";
  /** Other parameters held at these values while this one is swept (else 0):
   *  a ball's heading is swept leaning over at the edge of its cone. */
  hold?: Record<string, number>;
}

/** The driven joints, with the kind of motion each makes. A travel without
 *  stops on its joint has no known range, so it isn't swept. */
export function driveJoints(doc: CadDocument): Drive[] {
  const seen = new Set<string>();
  const out: Drive[] = [];
  const coupled = new Set(Object.values(doc.couplings ?? {}).map((c) => `${c.driven}.${c.drivenDof ?? "value"}`));
  const param = (e: string | undefined) => { const x = (e ?? "").trim(); return BARE_PARAM.test(x) && doc.parameters.some((p) => p.name === x) ? x : undefined; };
  const add = (j: Joint, dof: JointDof, expr: string | undefined, hold?: Record<string, number>) => {
    const p = param(expr);
    if (!p || seen.has(p) || coupled.has(`${j.id}.${dof}`)) return;
    const l = j.limits?.[dof];
    let d: Drive;
    if (isAngularDof(j.kind, dof)) {
      const min = l?.min ?? (dof === "tilt" && l?.max !== undefined ? 0 : undefined), max = l?.max;
      d = min === undefined && max === undefined ? { param: p, kind: j.kind, motion: "turn", from: 0, to: 360, unit: "°" }
        : { param: p, kind: j.kind, motion: "range", from: min ?? max! - 360, to: max ?? min! + 360, unit: "°" };
    } else {
      if (l?.min === undefined || l?.max === undefined) return;
      d = { param: p, kind: j.kind, motion: "slide", from: l.min, to: l.max, unit: "mm" };
    }
    seen.add(p); out.push(hold ? { ...d, hold } : d);
  };
  for (const j of Object.values(doc.joints)) {
    if (j.solve || j.closes) continue;
    if (j.kind === "revolute" || j.kind === "slider") add(j, "value", j.valueExpr);
    else if (j.kind === "cylindrical") { add(j, "value", j.valueExpr); add(j, "slide", j.slideExpr); }
    else if (j.kind === "ball") {
      add(j, "tilt", j.ball?.tilt);
      // the heading only shows leaning over: sweep it at the cone's edge (or square to the axis)
      const tilt = param(j.ball?.tilt);
      add(j, "heading", j.ball?.heading, tilt ? { [tilt]: j.limits?.tilt?.max ?? 90 } : undefined);
      add(j, "spin", j.ball?.spin);
    }
  }
  return out;
}

/** A drive's value at sample `k` of `steps`: round a full turn (0 up to, not
 *  including, 360), or from one stop to the other, both included. */
export function driveValue(d: Pick<Drive, "motion" | "from" | "to">, k: number, steps: number): number {
  if (d.motion === "turn") return (360 * k) / steps;
  return steps > 1 ? d.from + ((d.to - d.from) * k) / (steps - 1) : d.from;
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
  /** A pose is about to be checked: the parameter overrides that pose it (the swept joint at its angle, the
   *  other drives at 0), for a caller that follows the check pose by pose. */
  onPose?: (overrides: Record<string, string>) => void;
}

/** The order the poses are checked in: indices into an even `steps`-pose turn, a
 *  coarse `coarse` of them spread round it first, then the ones between. */
export function sampleOrder(steps: number, coarse: number): { first: number[]; rest: number[] } {
  const n = Math.max(1, Math.min(coarse, steps));
  const first = [...new Set(Array.from({ length: n }, (_, i) => Math.round((i * steps) / n) % steps))];
  const rest = Array.from({ length: steps }, (_, k) => k).filter((k) => !first.includes(k));
  return { first, rest };
}

/** How many poses a study checks: `steps` round each drive's turn, the one with every drive at 0 (where each
 *  turn starts) only once. */
export function poseCount(drives: number, steps: number): number {
  return drives > 0 ? drives * steps - (drives - 1) : 0;
}

/** Whether a drive's first sample is the rest pose (every drive at 0), which only one drive need check. */
const startsAtRest = (d: Drive, steps: number): boolean => !d.hold && driveValue(d, 0, steps) === 0;

/** How many poses a study of these drives checks: `steps` each, the rest pose (every drive at 0) only once. */
export function studyPoseCount(drives: Drive[], steps: number): number {
  const atRest = drives.filter((d) => startsAtRest(d, steps)).length;
  return drives.length * steps - Math.max(0, atRest - 1);
}

/** The key a verdict is kept under: the design's shape (its sketches, features,
 *  components, joints and the rest) and every parameter's expression except the
 *  swept drives' own (the study poses those itself). Values evaluated from an
 *  expression (`…Value`) are left out: they follow the pose, and the expressions
 *  already say what they come from. Display-only state (names, what is hidden,
 *  the drawing) doesn't move anything, so it is left out too. */
export function motionKey(doc: CadDocument): string {
  const drives = new Set(driveParams(doc));
  const shape = {
    components: doc.components, planes: doc.planes, joints: doc.joints, couplings: doc.couplings,
    componentPatterns: doc.componentPatterns, jointTemplates: doc.jointTemplates,
    sketches: doc.sketches, features: doc.features, configurations: doc.configurations, rollbackIndex: doc.rollbackIndex,
  };
  return contentHash(stableJson([
    doc.id, doc.activeConfiguration ?? null,
    doc.parameters.filter((p) => !drives.has(p.name)).map((p) => [p.name, p.expr]),
    JSON.parse(JSON.stringify(shape, (k, v) => (k.endsWith("Value") ? undefined : v))),
  ]));
}

/** A verdict in words, by the kind of motion checked: "Turns a full circle with
 *  nothing in the way", or what hit what, and where. */
export function motionVerdict(doc: CadDocument, res: MotionResult): string {
  if (res.status === "fail") return res.reason ?? "Parts collide";
  const drives = driveJoints(doc);
  const label = (n: string) => doc.parameters.find((p) => p.name === n)?.label;
  const motions = new Set(drives.map((d) => d.motion));
  // [one joint, several joints]
  const [one, many] = motions.size === 1 && motions.has("turn") ? ["turns a full circle", "turn a full circle"]
    : motions.size === 1 && motions.has("slide") ? ["slides its full travel", "slide their full travel"]
    : ["moves through its full range", "move through their full range"];
  const free = "with nothing in the way";
  if (drives.length > 1) return `All ${drives.length} joints ${many} ${free}`;
  const l = drives[0] && label(drives[0].param);
  return l ? `${l} ${one} ${free}` : `${one[0].toUpperCase()}${one.slice(1)} ${free}`;
}

/** Sweep each driven joint through its range (the others held at 0) and
 *  pass/fail on collision or a build error. Returns `null` if cancelled. */
export async function runMotionStudy(
  backend: GeometryBackend,
  doc: CadDocument,
  opts: MotionStudyOptions = {},
): Promise<MotionResult | null> {
  const steps = opts.steps ?? 12;
  const tol = opts.overlapTolerance ?? 1;
  const drives = driveJoints(doc);
  if (!drives.length) return { status: "pass", worstOverlap: 0 }; // nothing to move
  const called = (n: string) => doc.parameters.find((p) => p.name === n)?.label || n;
  const total = studyPoseCount(drives, steps);
  const { first, rest } = sampleOrder(steps, opts.coarse ?? 4);
  let done = 0;
  let worst = 0;
  let restChecked = false;
  const pose = async (d: Drive, k: number): Promise<MotionResult | null | undefined> => {
    if (opts.cancelled?.()) return null;
    const v = driveValue(d, k, steps);
    const at = `${called(d.param)} = ${d.unit === "°" ? `${Math.round(v)}°` : `${Math.round(v * 10) / 10} mm`}`;
    const overrides: Record<string, string> = { [d.param]: String(v) };
    for (const other of drives) if (other !== d) overrides[other.param] = "0";
    for (const [p, h] of Object.entries(d.hold ?? {})) overrides[p] = String(h);
    opts.onPose?.(overrides);
    let res;
    try {
      res = await backend.collide(doc, overrides);
    } catch (e) {
      return { status: "fail", reason: `crash at ${at}: ${(e as Error).message}`, worstOverlap: worst };
    }
    done++; opts.onProgress?.(done / total);
    if (res.buildError) {
      return { status: "fail", reason: `build error at ${at}: ${res.buildError}`, worstOverlap: worst };
    }
    worst = Math.max(worst, res.maxOverlap);
    if (res.maxOverlap > tol) {
      const pair = [...res.overlaps].sort((a, b) => b.volume - a.volume)[0];
      const where = pair ? `${pair.a} hits ${pair.b}` : "parts overlap";
      return { status: "fail", reason: `${where} at ${at}`, worstOverlap: worst };
    }
    return undefined; // clear
  };
  for (const pass of [first, rest]) {
    for (const d of drives) {
      for (const k of pass) {
        if (k === 0 && startsAtRest(d, steps)) { if (restChecked) continue; restChecked = true; } // every drive at 0: checked once
        const r = await pose(d, k);
        if (r !== undefined) return r;
      }
    }
    if (pass === first && rest.length) opts.onCoarseClear?.(done, total);
  }
  return { status: "pass", worstOverlap: worst };
}
