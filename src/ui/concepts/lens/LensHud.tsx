// The card at the lens's rim: the mode, shape, size (and print orientation)
// pills, the mode's readouts and its legend. A template over kit primitives;
// what it shows comes from lens.ts.

import { forwardRef } from "react";
import { Button, Card, Legend, Pills, Readout } from "../../kit/primitives";
import { CARD_W_WIDE } from "../../kit/anchor";
import { DRAFT, MODES, MODE_LABEL, ORIENTS, PULLS, QUANTITIES, SETTING_LABELS, SHAPE_CHOICES, SIZES, STRIPES, legendFor, pullKey, pullOf, readoutsFor, shapeChoice, stepTo, type AnalysisParams, type ShapeChoice, type StrainSummary, type LensMode, type LensShape, type LensSize, type Orient } from "./lens";

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
  /** The flexure working hardest (strain readouts). */
  strain?: StrainSummary;
  /** The wipe line's x (a wipe at the left edge reads as "Whole view"). */
  wipeX?: number;
  /** Curvature combs on the model's curved edges. */
  combs?: boolean;
  /** Faces that need support in the chosen orientation (overhang readout). */
  support?: { steep: number; total: number };
  onMode: (m: LensMode) => void;
  onShape: (s: ShapeChoice) => void;
  /** Change an analysis setting (stripes, draft angle, pull, quantity, combs): the Lens is their one home. */
  onAnalysis?: (patch: Partial<AnalysisParams & { combs: boolean }>) => void;
  onSize: (s: LensSize) => void;
  onOrient: (o: Orient) => void;
  onClose: () => void;
}

export const LensHud = forwardRef<HTMLDivElement, LensHudProps>(function LensHud(p, ref) {
  const legend = legendFor(p.mode);
  const readouts = readoutsFor(p.mode, p.analysis, { bodiesInside: p.bodiesInside, orient: p.orient, hasCurvature: p.hasCurvature, strain: p.strain, support: p.support })
    .filter((r) => !p.onAnalysis || !SETTING_LABELS.has(r.label));
  const a = p.analysis, set = p.onAnalysis;
  return (
    <Card ref={ref} at={p.at} width={p.width ?? CARD_W_WIDE} title={`${MODE_LABEL[p.mode]} lens`} ariaLabel="Lens" onClose={p.onClose} className="lens-hud">
      <Pills value={p.mode} options={MODES} onChange={p.onMode} ariaLabel="Lens mode" />
      <div className="lens-row">
        <Pills value={shapeChoice(p.shape, p.wipeX ?? -1)} options={SHAPE_CHOICES} onChange={p.onShape} ariaLabel="Lens shape" />
        <Pills value={p.size} options={SIZES} onChange={p.onSize} ariaLabel="Lens size" />
      </div>
      {p.mode === "overhang" && <Pills value={p.orient} options={ORIENTS} onChange={p.onOrient} ariaLabel="Print orientation" />}
      {set && p.mode === "zebra" && (
        <div className="lens-row">
          <Stepper label="Stripes" value={String(a.stripes)} onStep={(d) => set({ stripes: stepTo(a.stripes, d, STRIPES) })} />
        </div>
      )}
      {set && p.mode === "draft" && (
        <div className="lens-row">
          <Stepper label="Draft angle" value={`${a.draftDeg}°`} onStep={(d) => set({ draftDeg: stepTo(a.draftDeg, d, DRAFT) })} />
          <Pills value={pullKey(a.pull)} options={PULLS} onChange={(k) => set({ pull: pullOf(k) })} ariaLabel="Pull direction" />
        </div>
      )}
      {set && p.mode === "curvature" && (
        <div className="lens-row">
          <Pills value={a.quantity} options={QUANTITIES} onChange={(q) => set({ quantity: q })} ariaLabel="Curvature quantity" />
          <Button size="sm" on={!!p.combs} title="Curvature combs on the curved edges" onClick={() => set({ combs: !p.combs })}>Combs</Button>
        </div>
      )}
      <div className="lens-readouts">
        {readouts.map((r) => <Readout key={r.label} label={r.label} value={r.value} title={r.title} state={r.state} />)}
      </div>
      <Legend rows={legend.rows} ramp={legend.ramp} />
    </Card>
  );
});

/** A small − value + control for one analysis setting. */
function Stepper(p: { label: string; value: string; onStep: (d: number) => void }) {
  return (
    <span className="lens-stepper" role="group" aria-label={p.label}>
      <span className="k-label">{p.label}</span>
      <Button size="sm" icon ariaLabel={`Less ${p.label.toLowerCase()}`} onClick={() => p.onStep(-1)}>−</Button>
      <span className="k-num lens-stepper-value">{p.value}</span>
      <Button size="sm" icon ariaLabel={`More ${p.label.toLowerCase()}`} onClick={() => p.onStep(1)}>+</Button>
    </span>
  );
}
