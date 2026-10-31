// World → viewport-local pixels for screen-anchored HTML. Re-projects after
// every frame in which the camera moved and whenever the document changes,
// so pins and dimensions stay glued to their geometry.

import { useEffect, useMemo, useState } from "react";
import { getActiveScene, onActiveScene } from "../../viewport/sceneRef";
import type { SceneManager } from "../../viewport/SceneManager";
import { useStore } from "../../model/store";

export interface Projected { x: number; y: number; /** In front of the camera and inside the viewport. */ visible: boolean }
export interface Vec3Like { x: number; y: number; z: number }

/** The live scene, or null until the viewport has created it. */
export function useScene(): SceneManager | null {
  const [scene, setScene] = useState<SceneManager | null>(() => getActiveScene());
  useEffect(() => onActiveScene(setScene), []);
  return scene;
}

/** A counter that bumps on every camera move (and document change), for anything derived from the view. */
export function useViewTick(): number {
  const scene = useScene();
  const rev = useStore((s) => s.rev);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!scene) return;
    return scene.onCameraChange(() => setTick((t) => t + 1));
  }, [scene]);
  return tick + rev;
}

/** The viewport canvas's client rect (for local coordinates and card bounds). */
export function useViewportRect(): { left: number; top: number; w: number; h: number } {
  const scene = useScene();
  const tick = useViewTick();
  return useMemo(() => {
    const el = scene?.renderer.domElement;
    if (!el) return { left: 0, top: 0, w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, tick]);
}

/** Project world points to viewport-local pixels; the array is in the same order as `points`. */
export function useProjected(points: Vec3Like[]): Projected[] {
  const scene = useScene();
  const tick = useViewTick();
  const key = points.map((p) => `${p.x},${p.y},${p.z}`).join(";");
  return useMemo(() => {
    if (!scene) return points.map(() => ({ x: 0, y: 0, visible: false }));
    const el = scene.renderer.domElement, r = el.getBoundingClientRect();
    const { position, direction } = scene.cameraPose();
    return points.map((p) => {
      const s = scene.worldToScreen(p);
      const x = s.x - r.left, y = s.y - r.top;
      const ahead = (p.x - position.x) * direction.x + (p.y - position.y) * direction.y + (p.z - position.z) * direction.z > 0;
      return { x, y, visible: ahead && x >= 0 && y >= 0 && x <= r.width && y <= r.height };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, tick, key]);
}

/** Client (window) coordinates → viewport-local. */
export function toLocal(client: { x: number; y: number }, rect: { left: number; top: number }): { x: number; y: number } {
  return { x: client.x - rect.left, y: client.y - rect.top };
}
