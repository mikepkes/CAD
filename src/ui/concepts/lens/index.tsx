// The Lens: analysis where you look. Mounts in the viewport overlay
// (<Viewport overlays={<LensOverlay/>}/>). Shows while useUi.panels.lens is on
// (the shared panel switch, like every other concept); hidden in sketch mode.
// Pushes its spec to the scene's masked second pass (SceneManager.setLens) and
// clears it on unmount.
//
// Props: none required. `rect` overrides the viewport rect (tests, or a host
// that lays the overlay out itself); otherwise it is read from the live scene.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { useProjected, useScene, useViewportRect } from "../../kit/useProjected";
import { CARD_W_WIDE, CARD_FALLBACK_H } from "../../kit/anchor";
import { useCardSize } from "../../kit/useCardSize";
import { LensFrame } from "./LensFrame";
import { LensHud } from "./LensHud";
import { HUD_TOP_KEEPOUT, bodyCentres, countInside, frameOf, hasCurvature, hudPlacement, orientUp, strainSummary, supportArea, toLensSpec, useLens, type ShapeChoice } from "./lens";
import { useMechanism } from "../../../model/concepts/mechanismStore";
import { isReferenceBody } from "../../../core/document";
import "./lens.css";

export { useLens } from "./lens";
export type { LensState, LensMode, LensShape, LensSize, Orient } from "./lens";

export function LensOverlay(p: { rect?: { left: number; top: number; w: number; h: number } } = {}) {
  const lens = useLens();
  const on = useUi((s) => s.panels.lens);
  const togglePanel = useUi((s) => s.togglePanel);
  const appMode = useStore((s) => s.mode);
  const analysis = useStore((s) => s.analysis);
  const solids = useStore((s) => s.solids);
  const curvature = useStore((s) => hasCurvature(s.analysisData));
  const scene = useScene();
  const liveRect = useViewportRect();
  const rect = p.rect ?? liveRect;

  const visible = on && appMode === "model" && rect.w > 0 && rect.h > 0;

  // Curvature data is computed only on demand: hold a request while the lens shows it.
  const wantsCurvature = visible && lens.mode === "curvature";
  useEffect(() => {
    if (!wantsCurvature) return;
    void useStore.getState().requestCurvature(true);
    return () => { void useStore.getState().requestCurvature(false); };
  }, [wantsCurvature]);
  // Strain is read off the mechanism's pose: follow the document while the lens shows it.
  const wantsStrain = visible && lens.mode === "strain";
  useEffect(() => (wantsStrain ? useMechanism.getState().follow() : undefined), [wantsStrain]);
  const pose = useMechanism((s) => s.pose);
  const flexureCount = useStore((s) => Object.values(s.session.doc.joints).filter((j) => (j.kind === "flexure" && j.flexure) || (j.kind === "beam" && j.beam)).length);
  const strain = strainSummary(flexureCount, pose?.state);

  const bounds = { w: rect.w, h: rect.h };
  const frame = frameOf(lens, bounds);
  const spec = visible ? toLensSpec(lens, frame, analysis, pose?.segments) : null;
  const specKey = spec ? JSON.stringify(spec) : "";

  useEffect(() => {
    if (!scene) return;
    scene.setLens(spec);
    return () => scene.setLens(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, specKey]);

  const centres = useMemo(() => bodyCentres(solids), [solids]);
  const projected = useProjected(centres);
  const bodiesInside = countInside(frame, projected);

  // the area that needs support, read only while the overhang lens shows it
  const wantsSupport = visible && lens.mode === "overhang";
  // (a reference part, a stand-in or the board it hangs on, isn't printed: it needs no support)
  const doc = useStore((s) => s.session.doc);
  const support = useMemo(() => (wantsSupport ? supportArea(Object.values(solids).flatMap((b) => (b.mesh && !isReferenceBody(doc, b) ? [b.mesh] : [])), orientUp(lens.orient)) : undefined), [wantsSupport, solids, doc, lens.orient]);
  const onShape = (k: ShapeChoice) => {
    if (k === "whole") { lens.setShape("wipe"); lens.moveTo({ x: frame.x, y: frame.y, wipeX: 0 }); return; }
    if (k === "wipe" && lens.shape === "wipe" && frame.wipeX <= 0) lens.moveTo({ x: frame.x, y: frame.y, wipeX: Math.round(bounds.w / 2) });
    lens.setShape(k);
  };

  const cardRef = useRef<HTMLDivElement>(null);
  const cardSize = useCardSize(cardRef, { w: CARD_W_WIDE, h: CARD_FALLBACK_H });

  if (!visible) return null;
  return (
    <>
      <LensFrame frame={frame} rect={rect} onMove={lens.moveTo} />
      <LensHud
        ref={cardRef}
        at={hudPlacement(frame, cardSize, bounds, HUD_TOP_KEEPOUT)}
        width={CARD_W_WIDE}
        mode={lens.mode} shape={lens.shape} size={lens.size} orient={lens.orient}
        analysis={analysis} bodiesInside={bodiesInside} hasCurvature={curvature} strain={strain}
        wipeX={lens.wipeX} combs={analysis.combs} support={support}
        onAnalysis={(patch) => void useStore.getState().setAnalysis(patch)}
        onMode={lens.setMode} onShape={onShape} onSize={lens.setSize} onOrient={lens.setOrient} onClose={() => togglePanel("lens", false)}
      />
    </>
  );
}
