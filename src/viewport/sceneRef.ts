// A module-level handle to the live SceneManager, so non-viewport code (the
// embedded agent / WebMCP render_view tool, screen-anchored overlays) can ask
// the viewport for a rendering or a projection without the store importing
// the renderer.

import type { SceneManager } from "./SceneManager";

let active: SceneManager | null = null;
const listeners = new Set<(s: SceneManager | null) => void>();

export function setActiveScene(s: SceneManager | null): void {
  active = s;
  for (const fn of listeners) fn(s);
}
export function getActiveScene(): SceneManager | null {
  return active;
}
/** Be told when the live scene appears or goes away (overlays mount before the viewport's effect creates it). */
export function onActiveScene(fn: (s: SceneManager | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
