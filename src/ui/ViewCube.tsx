// A small view cube in the viewport's corner (M10): it turns with the camera,
// and a click on a face, an edge or a corner looks at the model from there.
// Model mode only (a sketch keeps its plane).

import { useEffect, useState } from "react";
import { useStore } from "../model/store";
import { getActiveScene, onActiveScene } from "../viewport/sceneRef";
import { cubeView, type Basis } from "./cubeGeometry";

const SIZE = 92, HALF = SIZE / 2;

export function ViewCube() {
  const mode = useStore((s) => s.mode);
  const [basis, setBasis] = useState<Basis | null>(null);
  useEffect(() => {
    let off: (() => void) | null = null;
    const attach = () => {
      off?.();
      const scene = getActiveScene();
      if (!scene) { setBasis(null); return; }
      const read = () => setBasis(scene.cameraBasis());
      read();
      off = scene.onCameraChange(read);
    };
    attach();
    const offScene = onActiveScene(attach);
    return () => { off?.(); offScene(); };
  }, []);
  if (mode !== "model" || !basis) return null;
  const v = cubeView(basis, HALF);
  const look = (dir: { x: number; y: number; z: number }) => window.dispatchEvent(new CustomEvent("vibecad:view", { detail: { dir } }));
  const pts = (p: { x: number; y: number }[]) => p.map((q) => `${q.x + HALF},${q.y + HALF}`).join(" ");
  return (
    <div className="view-cube" role="group" aria-label="View cube: look from a side, an edge or a corner">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {v.faces.map((f) => {
          const c = f.points.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
          return (
            <g key={f.key} className="vc-face" role="button" aria-label={`View from the ${f.label.toLowerCase()}`} tabIndex={0}
              onClick={() => look(f.dir)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); look(f.dir); } }}>
              <title>{f.label}</title>
              <polygon points={pts(f.points)} />
              {f.depth > 0.35 && <text x={c.x + HALF} y={c.y + HALF} textAnchor="middle" dominantBaseline="central">{f.label.toUpperCase()}</text>}
            </g>
          );
        })}
        {v.edges.map((e) => (
          <line key={e.key} className="vc-edge" x1={e.points[0].x + HALF} y1={e.points[0].y + HALF} x2={e.points[1].x + HALF} y2={e.points[1].y + HALF}
            role="button" aria-label={`View from the ${e.label.toLowerCase()}`} onClick={() => look(e.dir)}><title>{e.label}</title></line>
        ))}
        {v.corners.map((c) => (
          <circle key={c.key} className="vc-corner" cx={c.points[0].x + HALF} cy={c.points[0].y + HALF} r={4.5}
            role="button" aria-label={`View from the ${c.label.toLowerCase()}`} onClick={() => look(c.dir)}><title>{c.label}</title></circle>
        ))}
      </svg>
    </div>
  );
}
