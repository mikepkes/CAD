// The long-press selection picker: every face (and plane) under the cursor, nearest
// first. Hovering an entry lights that face on the model, drawn through anything in
// front of it, so you see what you are about to choose; choosing acts exactly as
// clicking that face would (src/model/pickMenu.ts, store.choosePick).

import { useEffect } from "react";
import { useStore } from "../model/store";
import { getActiveScene } from "../viewport/sceneRef";
import { faceTriangles, type PickItem } from "../model/pickMenu";

const light = (item: PickItem | null) => {
  const scene = getActiveScene();
  if (!scene) return;
  if (!item || item.kind !== "face") { scene.setPickHighlight(null); return; }
  scene.setPickHighlight(faceTriangles(useStore.getState().solids[item.bodyId]?.mesh, item.faceName));
};

export function PickMenu() {
  const menu = useStore((s) => s.pickMenu);
  const close = useStore((s) => s.closePickMenu);
  const choose = useStore((s) => s.choosePick);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); light(null); };
  }, [menu, close]);
  if (!menu) return null;
  const left = Math.min(menu.screen.x + 12, window.innerWidth - 280), top = Math.min(menu.screen.y + 12, window.innerHeight - 40 - menu.items.length * 44);
  return (
    <>
      <div className="pick-scrim" onPointerDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div className="pick-menu" role="menu" aria-label="Select from what is under the cursor" style={{ left, top }} onPointerLeave={() => light(null)}>
        <div className="pick-head">Select</div>
        {menu.items.map((it, i) => (
          <button key={i} role="menuitem" className="pick-item" onPointerEnter={() => light(it)} onFocus={() => light(it)} onClick={() => choose(it)}>
            <span className="pick-label">{it.label}</span>
            <span className="pick-detail">{it.detail}</span>
          </button>
        ))}
      </div>
    </>
  );
}
