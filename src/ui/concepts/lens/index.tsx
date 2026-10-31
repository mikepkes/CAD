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
import { bodyCentres, countInside, frameOf, hasCurvature, hudPlacement, toLensSpec, useLens } from "./lens";
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
  const bounds = { w: rect.w, h: rect.h };
  const frame = frameOf(lens, bounds);
  const spec = visible ? toLensSpec(lens, frame, analysis) : null;
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

  const cardRef = useRef<HTMLDivElement>(null);
  const cardSize = useCardSize(cardRef, { w: CARD_W_WIDE, h: CARD_FALLBACK_H });

  if (!visible) return null;
  return (
    <>
      <LensFrame frame={frame} rect={rect} onMove={lens.moveTo} />
      <LensHud
        ref={cardRef}
        at={hudPlacement(frame, cardSize, bounds)}
        width={CARD_W_WIDE}
        mode={lens.mode} shape={lens.shape} size={lens.size} orient={lens.orient}
        analysis={analysis} bodiesInside={bodiesInside} hasCurvature={curvature}
        onMode={lens.setMode} onShape={lens.setShape} onSize={lens.setSize} onOrient={lens.setOrient} onClose={() => togglePanel("lens", false)}
      />
    </>
  );
}
