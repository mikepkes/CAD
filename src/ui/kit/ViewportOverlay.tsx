// The HTML layer over the 3D view. Concepts render their screen-anchored
// pieces (pins, cards, lens frame, HUDs) into it; the layer itself ignores
// pointer events so orbiting still reaches the canvas between them.

import { ReactNode } from "react";

export function ViewportOverlay(p: { children?: ReactNode }) {
  return <div className="k-overlay">{p.children}</div>;
}
