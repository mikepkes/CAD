// The compliant mechanism as the Mechanism panel and the Strain lens read it:
// the pose it stands in (each flexure's strain, the drive's effort, the strain
// field in world space) and, per drive, the force–travel curve over the
// drive's whole range. It follows the document store while something that
// shows it is mounted (`follow()`, reference-counted), and keeps the solver off
// the render path: the pose is re-read shortly after each rebuild, and the
// curve — a sweep of the whole range, the slow part, in a Web Worker — only after the other
// parameters have been still for a moment, never while just the drive moves.
//
// Sweep steps the drive across its range through the store's command path
// (`setParameterExpr`), a step every 150 ms, so the model moves and the
// panel's marker runs along the curve. It is a preview: stopped or finished,
// the drive goes back to where it was and the undo history is as before.

import { create } from "zustand";
import { useStore } from "../store";
import { flexureEquilibria, flexureState, flexureSweep, hasFlexures, isAngularDrive, strainField, type FlexureState, type StrainSegment } from "../../sim/flexure";
import { buildCurve, drivesOf, fmt, sweepPlan, type MechanismCurve } from "./mechanism";

export interface MechanismPose {
  /** The store revision it was read at. */
  rev: number;
  /** The drive it was read along (null: no bounded drive). */
  drive: string | null;
  value: number;
  state: FlexureState;
  /** dU/d(drive) at this pose (NaN without a drive). */
  effort: number;
  segments: StrainSegment[];
}

export interface MechanismState {
  /** The drive the panel shows (null: the model's first). */
  drive: string | null;
  pose: MechanismPose | null;
  /** Force–travel curves by drive, each with the key of the parameters it was computed for. */
  curves: Record<string, { key: string; curve: MechanismCurve }>;
  /** A curve is being computed. */
  studying: boolean;
  /** The drive a Sweep is moving, or null. */
  sweeping: string | null;
  /** How many Mechanism panels are showing (a sweep with none shows a Stop chip over the viewport). */
  watchers: number;
  /** A Mechanism panel is showing; returns its release, which stops a running sweep (switching away ends the preview). */
  watch: () => () => void;
  setDrive: (name: string) => void;
  /** Start following the document store; returns the release. */
  follow: () => () => void;
  /** Read the pose and (re)compute the curve now, if due. */
  refresh: () => void;
  /** Step `drive` (default: the shown one) across its range and back. */
  sweep: (drive?: string, opts?: { perLeg?: number; stepMs?: number }) => Promise<void>;
  stopSweep: () => void;
}

const POSE_MS = 30;     // re-read the pose this long after a change
const CURVE_MS = 600;   // recompute a curve once the other parameters are still this long
const STEP_MS = 150;    // a Sweep step: the drive and the marker move this often; the model follows as fast as it rebuilds
const SAMPLES = 40;     // curve samples across a drive's range

const doc = () => useStore.getState().session.doc;

/** The drive the panel shows: the chosen one if the model still has it, else its first. */
export function activeDrive(chosen: string | null) {
  const drives = drivesOf(doc());
  return drives.find((d) => d.name === chosen) ?? drives[0] ?? null;
}

/** What a drive's curve depends on: the document and every other parameter. */
function curveKey(drive: string): string {
  const d = doc();
  return d.id + "|" + drive + "|" + JSON.stringify(d.parameters.filter((p) => p.name !== drive).map((p) => [p.name, p.expr]));
}

let followers = 0;
let unsub: (() => void) | null = null;
let poseTimer: ReturnType<typeof setTimeout> | undefined;
let curveTimer: ReturnType<typeof setTimeout> | undefined;
let sweepToken = 0;

// The curve's worker (mechanism.worker.ts), started on first use; without
// Worker (Node, jsdom) or if it cannot start, the curve is computed inline.
let worker: Worker | null = null;
let workerFailed = false;
let inflight: string | null = null;
let curveSeq = 0;
const replies = new Map<number, (r: { curve?: MechanismCurve; error?: string }) => void>();
function curveWorker(): Worker | null {
  if (worker || workerFailed || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./mechanism.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const r = e.data as { id: number; curve?: MechanismCurve; error?: string };
      const done = replies.get(r.id);
      replies.delete(r.id);
      done?.(r);
    };
    worker.onerror = () => {
      // a worker that fails to load: answer what is pending, and compute inline from now on
      workerFailed = true; worker = null;
      for (const [id, done] of replies) { replies.delete(id); done({ error: "worker failed" }); }
    };
  } catch { workerFailed = true; worker = null; }
  return worker;
}

export const useMechanism = create<MechanismState>((set, get) => {
  const readPose = () => {
    const d = doc();
    if (!hasFlexures(d)) { if (get().pose) set({ pose: null }); return; }
    const drive = activeDrive(get().drive);
    try {
      const at = drive ? flexureSweep(d, drive.name, [drive.value])[0] : { ...flexureState(d), effort: NaN };
      set({ pose: { rev: useStore.getState().rev, drive: drive?.name ?? null, value: drive?.value ?? NaN, state: at, effort: at.effort, segments: strainField(d, at) } });
    } catch {
      set({ pose: null });
    }
  };
  const store = (name: string, key: string, curve: MechanismCurve) => set({ curves: { ...get().curves, [name]: { key, curve } } });
  const readCurve = () => {
    const d = doc();
    const drive = hasFlexures(d) ? activeDrive(get().drive) : null;
    if (!drive || drive.min == null || drive.max == null) return;
    const key = curveKey(drive.name);
    if (get().curves[drive.name]?.key === key || inflight === key) return;
    const w = curveWorker();
    if (w) {
      // off the main thread, on a copy of the document; one at a time, and a
      // result for parameters that have since changed is kept but re-asked for
      if (inflight) return; // the reply schedules the next
      inflight = key;
      set({ studying: true });
      const id = ++curveSeq, name = drive.name;
      replies.set(id, (r) => {
        inflight = null;
        set({ studying: false });
        if (r.curve) store(name, key, r.curve);
        if (followers) schedule();
      });
      try {
        w.postMessage({ id, doc: d, param: name, min: drive.min, max: drive.max, samples: SAMPLES });
      } catch {
        replies.delete(id); inflight = null; worker = null; workerFailed = true; set({ studying: false });
        readCurve();
      }
      return;
    }
    set({ studying: true });
    try {
      const study = flexureEquilibria(d, drive.name, drive.min, drive.max, SAMPLES);
      store(drive.name, key, buildCurve(study, drive.name, isAngularDrive(d, drive.name), drive.min, drive.max));
    } finally {
      set({ studying: false });
    }
    readPose(); // the study leaves the model posed where it stands; read it again there
  };
  const schedule = () => {
    clearTimeout(poseTimer);
    poseTimer = setTimeout(readPose, POSE_MS);
    const drive = hasFlexures(doc()) ? activeDrive(get().drive) : null;
    if (drive && get().curves[drive.name]?.key !== curveKey(drive.name)) {
      clearTimeout(curveTimer);
      curveTimer = setTimeout(readCurve, CURVE_MS);
    }
  };
  return {
    drive: null,
    pose: null,
    curves: {},
    studying: false,
    sweeping: null,
    watchers: 0,
    watch: () => {
      set({ watchers: get().watchers + 1 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set({ watchers: Math.max(0, get().watchers - 1) });
        if (get().sweeping) get().stopSweep();
      };
    },
    setDrive: (name) => { set({ drive: name }); if (followers) schedule(); },
    follow: () => {
      followers++;
      if (followers === 1) {
        let rev = -1, d: unknown = null;
        unsub = useStore.subscribe((s) => {
          if (s.rev === rev && s.session.doc === d) return;
          rev = s.rev; d = s.session.doc;
          schedule();
        });
        schedule();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--followers === 0) { unsub?.(); unsub = null; clearTimeout(poseTimer); clearTimeout(curveTimer); }
      };
    },
    refresh: () => { clearTimeout(poseTimer); clearTimeout(curveTimer); readPose(); readCurve(); },
    sweep: async (name, opts = {}) => {
      if (get().sweeping) return;
      const drive = activeDrive(name ?? get().drive);
      if (!drive || drive.min == null || drive.max == null) return;
      const plan = sweepPlan(drive.value, drive.min, drive.max, opts.perLeg ?? 20, drive.step);
      const token = ++sweepToken;
      set({ sweeping: drive.name });
      // A sweep is a preview: it ends with the drive where it started and leaves nothing to undo.
      const st = useStore.getState();
      const mark = st.beginGesture();
      const startExpr = st.session.doc.parameters.find((p) => p.name === drive.name)?.expr ?? fmt(drive.value, 6);
      try {
        for (const v of plan) {
          if (token !== sweepToken) break;
          const t0 = Date.now();
          // The drive (and the chart's marker) steps on the clock; the model's
          // rebuild follows latest-wins, so a slow rebuild drops in-between
          // poses instead of slowing the sweep down.
          await useStore.getState().setParameterExpr(drive.name, fmt(v, 6));
          const wait = (opts.stepMs ?? STEP_MS) - (Date.now() - t0);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      } finally {
        try {
          const now = useStore.getState().session.doc.parameters.find((p) => p.name === drive.name)?.expr;
          if (now != null && now !== startExpr) await useStore.getState().setParameterExpr(drive.name, startExpr);
          useStore.getState().endGesture(mark, "drop");
          await useStore.getState().rebuildSolids(); // end on the model built where it started
        } finally {
          if (token === sweepToken) set({ sweeping: null });
        }
      }
    },
    stopSweep: () => { sweepToken++; set({ sweeping: null }); },
  };
});
