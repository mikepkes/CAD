// The card at the lens's rim: the mode, shape, size (and print orientation)
// pills, the mode's readouts and its legend. A template over kit primitives;
// what it shows comes from lens.ts.

import { forwardRef } from "react";
import { Card, Legend, Pills, Readout } from "../../kit/primitives";
import { CARD_W_WIDE } from "../../kit/anchor";
import { MODES, MODE_LABEL, ORIENTS, SHAPES, SIZES, legendFor, readoutsFor, type AnalysisParams, type LensMode, type LensShape, type LensSize, type Orient } from "./lens";

export interface LensHudProps {
  at: { x: number; y: number };
  width?: number;
  mode: LensMode;
  shape: LensShape;
  size: LensSize;
  orient: Orient;
  analysis: AnalysisParams;
  /** Bodies whose bounds centre is under the lens (x-ray readout). */
  bodiesInside: number;
  /** Whether any body carries curvature data right now. */
  hasCurvature: boolean;
  onMode: (m: LensMode) => void;
  onShape: (s: LensShape) => void;
  onSize: (s: LensSize) => void;
  onOrient: (o: Orient) => void;
  onClose: () => void;
}

export const LensHud = forwardRef<HTMLDivElement, LensHudProps>(function LensHud(p, ref) {
  const legend = legendFor(p.mode);
  const readouts = readoutsFor(p.mode, p.analysis, { bodiesInside: p.bodiesInside, orient: p.orient, hasCurvature: p.hasCurvature });
  return (
    <Card ref={ref} at={p.at} width={p.width ?? CARD_W_WIDE} title={`${MODE_LABEL[p.mode]} lens`} ariaLabel="Lens" onClose={p.onClose} className="lens-hud">
      <Pills value={p.mode} options={MODES} onChange={p.onMode} ariaLabel="Lens mode" />
      <div className="lens-row">
        <Pills value={p.shape} options={SHAPES} onChange={p.onShape} ariaLabel="Lens shape" />
        <Pills value={p.size} options={SIZES} onChange={p.onSize} ariaLabel="Lens size" />
      </div>
      {p.mode === "overhang" && <Pills value={p.orient} options={ORIENTS} onChange={p.onOrient} ariaLabel="Print orientation" />}
      <div className="lens-readouts">
        {readouts.map((r) => <Readout key={r.label} label={r.label} value={r.value} title={r.title} />)}
      </div>
      <Legend rows={legend.rows} ramp={legend.ramp} />
    </Card>
  );
});
