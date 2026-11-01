// A small progress bar in the viewport's top corner while the model rebuilds,
// shown only once a rebuild has taken more than a second: quick updates stay
// quiet, slow ones say how far they've got.

import { useEffect, useState } from "react";
import { useStore } from "../model/store";

/** How long a rebuild runs before the bar appears (ms). */
export const SHOW_AFTER_MS = 1000;

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
  const pct = Math.round(Math.min(1, Math.max(0, build.fraction)) * 100);
  return (
    <div className="build-progress" role="progressbar" aria-label="Rebuilding the model" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="build-progress-label">Rebuilding · {pct}%</span>
      <span className="build-progress-track"><span className="build-progress-fill" style={{ width: `${pct}%` }} /></span>
    </div>
  );
}
