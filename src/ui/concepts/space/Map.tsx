// The trade-off map: an SVG of the sampled grid with the pass cells shaded by
// the metric, fail cells hatched, each intent's frontier, the live design
// point with a crosshair, the pins and the lightest passing cell. Dragging or
// arrow keys move the design; every number comes from space.ts.

import { useId, useRef, KeyboardEvent, PointerEvent } from "react";
import type { Intent } from "../../../model/concepts/intents";
import { Legend } from "../../kit/primitives";
import {
  VIEW_W, VIEW_H, layout, cellSize, gridToSvg, clientToSvg, pointToValues, ticks, axisCoord, keyMove, metricRange, frontiers, frontierStroke, mapLegend,
  describePoint, formatMetric, cellOpacity, cellTitle, lightestMark,
  type GridSpec, type CellVerdict, type MetricKey, type Pin, type Verdict,
} from "./space";

export interface MapProps {
  spec: GridSpec;
  /** Judged cells indexed by cellKey(i, j, n); undefined where not yet sampled. */
  cells: (CellVerdict | undefined)[];
  metric: MetricKey;
  /** The intents drawn as frontiers, in the order their results appear in each cell. */
  intents: Intent[];
  /** The live design point (current parameter values). */
  current: { x: number; y: number };
  verdict: Verdict;
  /** The current design's metric, formatted, for the accessible label. */
  currentMetric?: string;
  lightest: CellVerdict | null;
  pins: Pin[];
  /** Fired while dragging and on each arrow key with the new (quantized) values. */
  onMove: (x: number, y: number) => void;
  /** Fired when a drag ends or after a key step. */
  onCommit: () => void;
}

export function DesignSpaceMap(p: MapProps) {
  const id = useId();
  const hatch = `hatch-${id.replace(/:/g, "")}`;
  const L = layout(p.spec.n);
  const cell = cellSize(L);
  const range = metricRange(p.cells, p.metric);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const valuesAt = (e: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: VIEW_W, height: VIEW_H };
    const s = clientToSvg(r, e.clientX, e.clientY);
    return pointToValues(p.spec, L, s.x, s.y);
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    const v = valuesAt(e);
    p.onMove(v.x, v.y);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const v = valuesAt(e);
    p.onMove(v.x, v.y);
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    p.onCommit();
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const next = keyMove(p.spec, p.current, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    p.onMove(next.x, next.y);
    p.onCommit();
  };

  const cur = gridToSvg(L, axisCoord(p.spec.x, p.current.x, p.spec.n), axisCoord(p.spec.y, p.current.y, p.spec.n));
  const fronts = frontiers(p.cells, p.spec.n, p.intents);

  return (
    <div className="space-map-wrap">
      <svg
        ref={svgRef}
        className="space-map"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        tabIndex={0}
        aria-label={describePoint(p.spec, p.current.x, p.current.y, p.verdict, p.currentMetric)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <defs>
          <pattern id={hatch} patternUnits="userSpaceOnUse" width="6" height="6">
            <path d="M0 6 L6 0" className="space-hatch" />
          </pattern>
        </defs>
        <rect className="space-plot" x={L.left} y={L.top} width={L.w} height={L.h} />
        <g className="space-cells" data-testid="space-cells">
          {p.cells.map((c) => {
            if (!c) return null;
            const at = gridToSvg(L, c.i, c.j);
            const v = c.metrics?.[p.metric];
            const x = at.x - cell.w / 2, y = at.y - cell.h / 2;
            return (
              <g key={`${c.i},${c.j}`} data-cell={`${c.i},${c.j}`} data-pass={c.pass ? "1" : "0"}>
                <title>{cellTitle(p.spec, c, p.metric)}</title>
                {c.pass && v != null ? (
                  <rect className="space-cell pass" x={x} y={y} width={cell.w} height={cell.h} style={{ fillOpacity: cellOpacity(v, range) }} />
                ) : (
                  <>
                    <rect className="space-cell fail" x={x} y={y} width={cell.w} height={cell.h} />
                    <rect x={x} y={y} width={cell.w} height={cell.h} fill={`url(#${hatch})`} />
                  </>
                )}
              </g>
            );
          })}
        </g>
        <g className="space-frontiers">
          {fronts.map((f, k) => (
            <g key={f.id} data-frontier={f.id} style={{ stroke: frontierStroke(k, p.intents.length) }} className={k < p.intents.length ? "space-frontier" : "space-frontier all"}>
              {f.segments.map((s, m) => {
                const a = gridToSvg(L, s.x1, s.y1), b = gridToSvg(L, s.x2, s.y2);
                return <line key={m} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
              })}
            </g>
          ))}
        </g>
        <g className="space-axis">
          <line x1={L.left} y1={L.top + L.h} x2={L.left + L.w} y2={L.top + L.h} />
          <line x1={L.left} y1={L.top} x2={L.left} y2={L.top + L.h} />
          {ticks(p.spec.x, p.spec.n).map((t) => {
            const s = gridToSvg(L, t.coord, -0.5);
            return <g key={`x${t.coord}`}><line x1={s.x} y1={s.y} x2={s.x} y2={s.y + 4} /><text x={s.x} y={s.y + 16} textAnchor="middle">{t.label}</text></g>;
          })}
          {ticks(p.spec.y, p.spec.n).map((t) => {
            const s = gridToSvg(L, -0.5, t.coord);
            return <g key={`y${t.coord}`}><line x1={s.x - 4} y1={s.y} x2={s.x} y2={s.y} /><text x={s.x - 7} y={s.y + 4} textAnchor="end">{t.label}</text></g>;
          })}
          <text className="space-axis-name" x={L.left + L.w / 2} y={VIEW_H - 8} textAnchor="middle">{p.spec.x.name}{p.spec.x.unit ? ` (${p.spec.x.unit})` : ""}</text>
          <text className="space-axis-name" transform={`translate(12 ${L.top + L.h / 2}) rotate(-90)`} textAnchor="middle">{p.spec.y.name}{p.spec.y.unit ? ` (${p.spec.y.unit})` : ""}</text>
        </g>
        {p.lightest && (
          <path className="space-lightest" data-testid="space-lightest" d={lightestMark(gridToSvg(L, p.lightest.i, p.lightest.j), cell)}><title>Lightest that passes: {formatMetric(p.lightest.metrics?.[p.metric], p.metric)}</title></path>
        )}
        {p.pins.filter((pin) => pin.xName === p.spec.x.name && pin.yName === p.spec.y.name).map((pin) => {
          const s = gridToSvg(L, axisCoord(p.spec.x, pin.x, p.spec.n), axisCoord(p.spec.y, pin.y, p.spec.n));
          return <g key={pin.letter} className="space-pin-mark" data-pin={pin.letter}><circle cx={s.x} cy={s.y} r={9} /><text x={s.x} y={s.y + 4} textAnchor="middle">{pin.letter}</text></g>;
        })}
        <g className="space-current" data-testid="space-current" data-x={p.current.x} data-y={p.current.y}>
          <line className="space-cross" x1={L.left} y1={cur.y} x2={L.left + L.w} y2={cur.y} />
          <line className="space-cross" x1={cur.x} y1={L.top} x2={cur.x} y2={L.top + L.h} />
          <circle cx={cur.x} cy={cur.y} r={6} className={`space-point ${p.verdict}`} />
        </g>
      </svg>
      <Legend rows={mapLegend(p.metric, fronts, p.intents.length)} />
    </div>
  );
}
