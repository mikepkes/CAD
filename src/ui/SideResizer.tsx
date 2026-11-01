import { useRef } from "react";
import { useUi, SIDE_DEFAULT, type Side } from "../model/concepts/uiState";

/** The grip on a side panel's inner edge: drag to resize the panel, double-click to reset it. */
export function SideResizer({ side }: { side: Side }) {
  const setSideWidth = useUi((s) => s.setSideWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  // the left panel grows as the grip moves right, the right panel as it moves left
  const widthAt = (x: number) => drag.current!.w + (side === "left" ? x - drag.current!.x : drag.current!.x - x);
  return (
    <div
      className={`side-resize ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${side} panel`}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: useUi.getState().sideWidth[side] };
        document.body.classList.add("side-resizing");
      }}
      onPointerMove={(e) => { if (drag.current) setSideWidth(side, widthAt(e.clientX), false); }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        setSideWidth(side, widthAt(e.clientX));
        drag.current = null;
        document.body.classList.remove("side-resizing");
      }}
      onPointerCancel={() => { drag.current = null; document.body.classList.remove("side-resizing"); }}
      onDoubleClick={() => setSideWidth(side, SIDE_DEFAULT)}
    />
  );
}
