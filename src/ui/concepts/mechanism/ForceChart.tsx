// The force–travel chart: the drive's effort across its range, the zero line,
// rest positions (filled), the tipping point between them (hollow), the snap
// force, and a marker at the drive's current value. A template over
// chartGeometry (src/model/concepts/mechanism.ts); hovering reads a value off.

import { useState, PointerEvent } from "react";
import { chartGeometry, effortAt, fmt, fmtDrive, fmtEffort, labelSide, type MechanismCurve } from "../../../model/concepts/mechanism";

const CHART = { w: 256, h: 188, left: 40, right: 10, top: 16, bottom: 30 };

export function ForceChart(p: { curve: MechanismCurve; value: number }) {
  const { curve } = p;
  const g = chartGeometry(curve, CHART);
  const [hover, setHover] = useState<number | null>(null);
  const x0 = CHART.left, x1 = CHART.w - CHART.right, y0 = CHART.top, y1 = CHART.h - CHART.bottom;
  const inRange = Number.isFinite(p.value) && p.value >= curve.min - 1e-9 && p.value <= curve.max + 1e-9;
  const clampY = (y: number) => Math.min(y1, Math.max(y0, y)); // the curve can run off the plot past the last rest
  const now = inRange ? { x: g.sx(p.value), y: clampY(g.sy(effortAt(curve, p.value))) } : null;
  const what = curve.angular ? "Torque" : "Force";
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const f = (e.clientX - r.left) / r.width;
    setHover(curve.min + Math.min(1, Math.max(0, f)) * (curve.max - curve.min));
  };
  const hv = hover != null ? { x: g.sx(hover), y: clampY(g.sy(effortAt(curve, hover))) } : null;
  const summary = `${what} against ${curve.param}: ${curve.stable.length} rest position${curve.stable.length === 1 ? "" : "s"}` +
    (curve.stable.length ? ` at ${curve.stable.map((s) => fmtDrive(s.x, curve.angular)).join(" and ")}` : "") +
    (curve.snap ? `, snaps over at ${fmtEffort(curve.snap.y, curve.angular)}` : "");
  return (
    <svg className="mech-chart" viewBox={`0 0 ${CHART.w} ${CHART.h}`} role="img" aria-label={`${what} against ${curve.param}`}>
      <title>{summary}</title>
      {g.yTicks.map((t) => (
        <g key={`y${t}`}>
          <line className={t === 0 ? "mech-zero" : "mech-grid"} x1={x0} x2={x1} y1={g.sy(t)} y2={g.sy(t)} />
          <text className="mech-tick" x={x0 - 5} y={g.sy(t) + 3.5} textAnchor="end">{fmt(t, 2)}</text>
        </g>
      ))}
      {g.xTicks.map((t) => (
        <text key={`x${t}`} className="mech-tick" x={g.sx(t)} y={y1 + 13} textAnchor="middle">{fmt(t, 2)}</text>
      ))}
      <text className="mech-axis" x={(x0 + x1) / 2} y={CHART.h - 3} textAnchor="middle">{curve.param} ({curve.unit})</text>
      <text className="mech-axis" x={4} y={10}>{what.toLowerCase()} ({curve.effortUnit})</text>
      <clipPath id="mech-plot"><rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} /></clipPath>
      <path className="mech-curve" d={g.path} data-testid="force-curve" clipPath="url(#mech-plot)" />
      {curve.snap && (
        <g data-testid="snap-marker">
          <path className="mech-snap" d={`M${g.sx(curve.snap.x)},${g.sy(curve.snap.y) - 6}l6,6l-6,6l-6,-6z`} />
          <text className="mech-label" x={g.sx(curve.snap.x) + (labelSide(g.sx(curve.snap.x), x0, x1) === "end" ? -9 : 9)} y={g.sy(curve.snap.y) + 4}
            textAnchor={labelSide(g.sx(curve.snap.x), x0, x1)}>snap {fmtEffort(curve.snap.y, curve.angular)}</text>
        </g>
      )}
      {curve.unstable.map((u) => (
        <circle key={`u${u.x}`} className="mech-unstable" cx={g.sx(u.x)} cy={g.zeroY} r={5} data-testid="unstable-marker">
          <title>{`Tipping point (unstable) at ${fmtDrive(u.x, curve.angular)}`}</title>
        </circle>
      ))}
      {curve.stable.map((s) => (
        <circle key={`s${s.x}`} className="mech-stable" cx={g.sx(s.x)} cy={g.zeroY} r={5.5} data-testid="rest-marker">
          <title>{`Rest position (stable) at ${fmtDrive(s.x, curve.angular)}`}</title>
        </circle>
      ))}
      {now && (
        <g data-testid="current-marker" data-x={p.value}>
          <line className="mech-now-line" x1={now.x} x2={now.x} y1={y0} y2={y1} />
          <circle className="mech-now" cx={now.x} cy={now.y} r={5} />
        </g>
      )}
      {hv && (
        <g className="mech-hover" data-testid="chart-hover">
          <line className="mech-hover-line" x1={hv.x} x2={hv.x} y1={y0} y2={y1} />
          <text className="mech-label" x={hv.x + (labelSide(hv.x, x0, x1) === "end" ? -6 : 6)} y={y0 + 10} textAnchor={labelSide(hv.x, x0, x1)}>
            {fmtDrive(hover!, curve.angular)} · {fmtEffort(effortAt(curve, hover!), curve.angular)}
          </text>
        </g>
      )}
      <rect className="mech-hit" x={x0} y={y0} width={x1 - x0} height={y1 - y0} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
    </svg>
  );
}
