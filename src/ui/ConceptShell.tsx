// The pieces of the app shell the concept UI adds: the panel switches over the
// viewport (with the action ring, which portals over the whole window) and the
// tabbed right side panel. Thin templates over useUi; which tab can show is
// decided in uiState.ts (rightTabFor).

import { useLayoutEffect, useRef, useState } from "react";
import { InspectorPanel } from "./InspectorPanel";
import { useUi, PANEL_NAMES, type ConceptPanel, type RightTab } from "../model/concepts/uiState";
import { OverflowRow, type OverflowRowItem } from "./kit/OverflowRow";
import { showCrumb } from "./concepts/workbench/workbench";
import { Button, Pills } from "./kit/primitives";
import { LedgerPanel } from "./concepts/ledger";
import { DesignSpacePanel } from "./concepts/space";
import { IntentButton } from "./concepts/intent";
import { RingOverlay } from "./concepts/ring";
import { MechanismPanel } from "./concepts/mechanism";
import { useStore } from "../model/store";
import { hasFlexures } from "../sim/flexure";
import { MaterialsPanel } from "./concepts/materials";
import { NotesPanel } from "./concepts/notes";
import { useMechanism } from "../model/concepts/mechanismStore";

/** Switches for the concept surfaces, at the top-right of the viewport: one line, whatever does not fit goes
 *  into a ⋯ menu; clear of the component crumb at the top-left; hidden while sketching (the sketch needs the
 *  whole view, and the switches are in ⌘K and the hotkeys). Also mounts the action ring once (it renders into
 *  document.body while open). */
export function PanelToggles() {
  const panels = useUi((s) => s.panels);
  const toggle = useUi((s) => s.togglePanel);
  const compliant = useStore((s) => hasFlexures(s.session.doc));
  const mode = useStore((s) => s.mode);
  const crumb = useStore((s) => showCrumb(s.session.doc)) && panels.workbench && mode === "model";
  useStore((s) => s.activeComponentId); // the crumb's width follows the active component
  const left = useCrumbClearance(crumb);
  const sw = (p: ConceptPanel, title: string) => ({
    key: p,
    node: <Button size="sm" on={!!panels[p]} title={title} onClick={() => toggle(p)}>{PANEL_NAMES[p]}</Button>,
  });
  const items: OverflowRowItem[] = [
    { ...sw("workbench", "Pins: numbered feature pins on the part, and the history strip under the view"), priority: 5 },
    { ...sw("lens", "Lens: analysis under a draggable lens"), priority: 4 },
    { ...sw("ledger", "Ledger: the model read back as sentences, with design intents"), priority: 3 },
    { ...sw("space", "Space: two parameters on a map, intents as frontiers"), priority: 2 },
    { ...sw("materials", "Materials: metals, plastics, prints, rubber, wood; apply them to parts"), priority: 1 },
    { ...sw("notes", "Notes: notes and sketches on the design, by you and the agent, pinned to what they are about"), priority: 1 },
    ...(compliant || panels.mechanism ? [{ ...sw("mechanism", "Mechanism: force against travel, its rest positions, the strain in each flexure"), priority: 1 }] : []),
    { key: "intent", node: <IntentButton size="sm" />, pin: true },
  ];
  return (
    <>
      {mode !== "sketch" && (
        <OverflowRow className={`k-panel-toggle${crumb ? " beside-crumb" : ""}`} style={left != null ? { left } : undefined} role="toolbar" ariaLabel="Concept panels" moreLabel="More panels" items={items} />
      )}
      <RingOverlay />
    </>
  );
}

/** Where the switch row may start: just right of the component crumb at the view's top-left (null: no crumb,
 *  the stylesheet's default). Measured after each render, as the crumb's width follows the active component. */
function useCrumbClearance(crumb: boolean): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const view = document.querySelector(".center-view");
    const el = crumb ? view?.querySelector(".wb-crumb") : null;
    const next = el && view ? Math.round(el.getBoundingClientRect().right - view.getBoundingClientRect().left + 12) : null;
    if (next !== left && !(next != null && next <= 12)) setLeft(next);
  });
  return left;
}

/** The right side panel: the inspector, with Ledger, Space, Mechanism, Materials and Notes as tabs while their panels are on. */
export function RightPanel() {
  const panels = useUi((s) => s.panels);
  const tab = useUi((s) => s.rightTab);
  const setTab = useUi((s) => s.setRightTab);
  const options: { key: RightTab; label: string }[] = [
    { key: "inspector", label: "Inspector" },
    ...(["ledger", "space", "mechanism", "materials", "notes"] as const).filter((k) => panels[k]).map((k) => ({ key: k, label: PANEL_NAMES[k] })),
  ];
  return (
    <>
      {options.length > 1 && (
        <div className="k-tabs">
          <Pills ariaLabel="Right panel" value={tab} options={options} onChange={setTab} />
        </div>
      )}
      {tab === "ledger" && panels.ledger ? <LedgerPanel /> : tab === "space" && panels.space ? <DesignSpacePanel /> : tab === "mechanism" && panels.mechanism ? <MechanismPanel /> : tab === "materials" && panels.materials ? <MaterialsPanel /> : tab === "notes" && panels.notes ? <NotesPanel /> : <InspectorPanel />}
    </>
  );
}

/** Chips at the viewport's bottom-left for work no open panel shows: a Sweep started from the ring or a hotkey
 *  while the Mechanism tab is hidden, with its Stop; the motion study run from the editor (toolbar, ring, ⌘K),
 *  its progress and its verdict until the model changes. */
export function ViewChips() {
  const sweeping = useMechanism((s) => s.sweeping);
  const watched = useMechanism((s) => s.watchers > 0);
  const motion = useStore((s) => s.motionStatus);
  const progress = useStore((s) => s.motionProgress);
  const result = useStore((s) => s.motionResult);
  const ghost = useStore((s) => s.motionGhost);
  const doc = useStore((s) => s.session.doc);
  // the verdict belongs to the document it was checked on: an edit retires it
  const checkedOn = useRef<unknown>(null);
  const wasRunning = useRef(false);
  if (motion === "running" && !wasRunning.current) checkedOn.current = doc;
  wasRunning.current = motion === "running";
  const verdict = (motion === "pass" || motion === "fail") && checkedOn.current === doc;
  const sweep = !!sweeping && !watched;
  if (!sweep && motion !== "running" && !verdict) return null;
  return (
    <div className="view-chips" role="status" aria-live="polite">
      {sweep && (
        <span className="view-chip">
          <span>Sweeping {sweeping}…</span>
          <Button size="sm" onClick={() => useMechanism.getState().stopSweep()} title="Stop the sweep and put the drive back">Stop</Button>
        </span>
      )}
      {motion === "running" && (
        <span className="view-chip" data-testid="motion-chip">
          <span>Motion study {Math.round(progress * 100)}%</span>
          <span className="view-chip-bar" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
          <Button size="sm" on={ghost} title="Show the motion in the view as it is checked: see-through copies of the moving parts at the latest positions"
            onClick={() => useStore.getState().setMotionGhost(!ghost)}>Show motion</Button>
          <Button size="sm" onClick={() => useStore.getState().cancelMotionStudy()}>Stop</Button>
        </span>
      )}
      {verdict && (
        <span className={`view-chip ${motion}`} data-testid="motion-chip">
          <span>{motion === "pass" ? "✓ Moves through its range without collisions" : `✕ ${result?.reason ?? "Parts collide in the motion study"}`}</span>
          <Button size="sm" ghost ariaLabel="Dismiss the motion study" onClick={() => useStore.getState().cancelMotionStudy()}>×</Button>
        </span>
      )}
    </div>
  );
}
