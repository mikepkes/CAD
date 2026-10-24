// A module-level handle to the live SceneManager, so non-viewport code (the
// embedded agent / WebMCP render_view tool) can ask the viewport for a
// rendering without the store importing the renderer.

import type { SceneManager } from "./SceneManager";

let active: SceneManager | null = null;

export function setActiveScene(s: SceneManager | null): void {
  active = s;
}
export function getActiveScene(): SceneManager | null {
  return active;
}
