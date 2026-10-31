// Numbered pins on the geometry of the active component, one per feature row,
// with leader lines; other components collapse into one badge each. Overlapping
// pins merge into a cluster badge that opens a small chooser.

import { useRef, useState } from "react";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { useProjected, useViewportRect } from "../../kit/useProjected";
import { clusterPins, placeCard, CARD_W_NARROW } from "../../kit/anchor";
import { Button, Card, Pin } from "../../kit/primitives";
import { useFeatureRows, useActiveComponent } from "../../kit/useFeatureRows";
import { useCardSize } from "../../kit/useCardSize";
import { CLUSTER_RADIUS, chooserSize, clusterKey, clusterLabel, componentLabel, hasMember, leaderState, otherComponentGroups, pinAnchors, pinState, placePins, visiblePins } from "./workbench";

export function Pins() {
  const rows = useFeatureRows();
  const active = useActiveComponent();
  const mode = useStore((s) => s.mode);
  const components = useStore((s) => s.session.doc.components);
  const activateComponent = useStore((s) => s.activateComponent);
  const openFeature = useUi((s) => s.openFeature);
  const hotFeature = useUi((s) => s.hotFeature);
  const setOpenFeature = useUi((s) => s.setOpenFeature);
  const setHotFeature = useUi((s) => s.setHotFeature);
  const [chooser, setChooser] = useState<string | null>(null);
  const rect = useViewportRect();

  const mine = visiblePins(rows, pinAnchors(rows), active);
  const groups = otherComponentGroups(rows, active).filter((g) => g.centre);
  const projected = useProjected(mine.map((m) => m.anchor));
  const centres = useProjected(groups.map((g) => g.centre!));
  const chooserRef = useRef<HTMLDivElement>(null);

  const bounds = { w: rect.w, h: rect.h };
  const pins = placePins(mine.map((m, i) => ({ row: m.row, proj: projected[i] })), bounds);
  const clusters = clusterPins(pins, CLUSTER_RADIUS);
  const open = chooser ? clusters.find((c) => clusterKey(c.members) === chooser) : null;
  const chooserBox = useCardSize(chooserRef, chooserSize(open?.members.length ?? 0));
  if (mode !== "model") return null;

  return (
    <>
      <svg className="k-leader" aria-hidden="true">
        {pins.map((p) => (
          <g key={p.row.featureId}>
            <line className={leaderState(p.row, openFeature)} x1={p.anchor.x} y1={p.anchor.y} x2={p.pos.x} y2={p.pos.y} />
            <circle cx={p.anchor.x} cy={p.anchor.y} r={2.5} />
          </g>
        ))}
      </svg>
      {clusters.map((c) => {
        if (c.members.length === 1) {
          const { row, pos } = c.members[0];
          const state = pinState(row, openFeature);
          return (
            <Pin
              key={row.featureId}
              at={pos}
              state={state}
              hot={hotFeature === row.featureId && state !== "open"}
              ariaLabel={`Feature ${row.num}: ${row.name}`}
              ariaPressed={state === "open"}
              title={row.name}
              onClick={() => { setChooser(null); setOpenFeature(state === "open" ? null : row.featureId); }}
              onHover={(on) => setHotFeature(on ? row.featureId : null)}
            >
              {row.num}
            </Pin>
          );
        }
        const key = clusterKey(c.members);
        const label = clusterLabel(c.members.map((m) => m.row.num));
        return (
          <Pin
            key={key}
            at={c.pos}
            cluster
            state={hasMember(c.members, openFeature) ? "open" : ""}
            hot={hasMember(c.members, hotFeature)}
            ariaLabel={`Features ${label}`}
            ariaExpanded={chooser === key}
            onClick={() => setChooser(chooser === key ? null : key)}
          >
            {label}
          </Pin>
        );
      })}
      {open && (
        <Card ref={chooserRef} role="menu" ariaLabel="Choose a feature" className="wb-chooser" at={placeCard({ anchor: open.pos, size: chooserBox, bounds, prefer: "below" })} width={CARD_W_NARROW}>
          {open.members.map((m) => (
            <Button key={m.row.featureId} size="sm" ghost onClick={() => { setChooser(null); setOpenFeature(m.row.featureId); }}>
              <span className="k-num">{m.row.num}</span> {m.row.name}
            </Button>
          ))}
        </Card>
      )}
      {groups.map((g, i) => {
        const p = centres[i];
        if (!p?.visible) return null;
        const name = components[g.componentId]?.name ?? g.componentId;
        return (
          <Pin key={g.componentId} at={p} cluster className="wb-component" ariaLabel={`Activate ${name} (${g.rows.length} features)`} title={`Activate ${name}`} onClick={() => activateComponent(g.componentId)}>
            {componentLabel(name, g.rows.length)}
          </Pin>
        );
      })}
    </>
  );
}
