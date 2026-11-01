// A small progress bar in the viewport's top corner while the model rebuilds,
// shown only once a rebuild has taken more than a second: quick updates stay
// quiet, slow ones say how far they've got — and which phase they're in, since
// the last one (meshing) can sit near the end of the bar for seconds.

import { useEffect, useState } from "react";
import { useStore } from "../model/store";
import type { BuildStep } from "../core/features";

/** How long a rebuild runs before the bar appears (ms). */
export const SHOW_AFTER_MS = 1000;

/** What a build is doing, in words: "Building 12 of 44 features", "Meshing 3 of 29 parts". */
export function buildStepText(step: BuildStep | undefined): string {
  if (!step || !step.total) return "Rebuilding";
  const n = Math.min(step.done + 1, step.total);
  return step.phase === "features" ? `Building ${n} of ${step.total} feature${step.total === 1 ? "" : "s"}` : `Meshing ${n} of ${step.total} part${step.total === 1 ? "" : "s"}`;
}

/** A build's percentage (0…100). */
export const buildPercent = (fraction: number): number => Math.round(Math.min(1, Math.max(0, fraction)) * 100);

export function BuildProgress() {
  const build = useStore((s) => s.build);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!build) { setLate(false); return; }
    const wait = SHOW_AFTER_MS - (performance.now() - build.started);
    if (wait <= 0) { setLate(true); return; }
    const t = setTimeout(() => setLate(true), wait);
    return () => clearTimeout(t);
  }, [build?.started]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!build || !late) return null;
  const pct = buildPercent(build.fraction);
  const text = buildStepText(build.step);
  return (
    <div className="build-progress" role="progressbar" aria-label="Rebuilding the model" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${text}, ${pct}%`}>
      <span className="build-progress-label">{text} · {pct}%</span>
      <span className="build-progress-track"><span className="build-progress-fill" style={{ width: `${pct}%` }} /></span>
    </div>
  );
}
