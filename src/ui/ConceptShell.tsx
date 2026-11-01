// The pieces of the app shell the concept UI adds: the panel switches over the
// viewport (with the action ring, which portals over the whole window) and the
// tabbed right side panel. Thin templates over useUi; which tab can show is
// decided in uiState.ts (rightTabFor).

import { InspectorPanel } from "./InspectorPanel";
import { useUi, type RightTab } from "../model/concepts/uiState";
import { Button, Pills } from "./kit/primitives";
import { LedgerPanel } from "./concepts/ledger";
import { DesignSpacePanel } from "./concepts/space";
import { IntentButton } from "./concepts/intent";
import { RingOverlay } from "./concepts/ring";
import { MechanismPanel } from "./concepts/mechanism";
import { useStore } from "../model/store";
import { hasFlexures } from "../sim/flexure";
import { MaterialsPanel } from "./concepts/materials";
import { useMechanism } from "../model/concepts/mechanismStore";

/** Switches for the concept surfaces, at the top-right of the viewport; also
 *  mounts the action ring once (it renders into document.body while open). */
export function PanelToggles() {
  const panels = useUi((s) => s.panels);
  const toggle = useUi((s) => s.togglePanel);
  const compliant = useStore((s) => hasFlexures(s.session.doc));
  return (
    <>
      <div className="k-panel-toggle" role="toolbar" aria-label="Concept panels">
        <Button size="sm" on={panels.workbench} title="Feature pins and history strip on the part" onClick={() => toggle("workbench")}>Pins</Button>
        <Button size="sm" on={panels.lens} title="Analysis under a draggable lens" onClick={() => toggle("lens")}>Lens</Button>
        <Button size="sm" on={panels.ledger} title="The model read back as sentences, with design intents" onClick={() => toggle("ledger")}>Ledger</Button>
        <Button size="sm" on={panels.space} title="Two parameters on a map, intents as frontiers" onClick={() => toggle("space")}>Space</Button>
        <Button size="sm" on={!!panels.materials} title="Materials: metals, plastics, prints, rubber, wood; apply them to parts" onClick={() => toggle("materials")}>Materials</Button>
        {(compliant || panels.mechanism) && <Button size="sm" on={!!panels.mechanism} title="The compliant mechanism: force against travel, its rest positions, the strain in each flexure" onClick={() => toggle("mechanism")}>Mechanism</Button>}
        <IntentButton size="sm" />
      </div>
      <RingOverlay />
    </>
  );
}

/** The right side panel: the inspector, with Ledger, Design Space and Mechanism as tabs while their panels are on. */
export function RightPanel() {
  const panels = useUi((s) => s.panels);
  const tab = useUi((s) => s.rightTab);
  const setTab = useUi((s) => s.setRightTab);
  const options: { key: RightTab; label: string }[] = [
    { key: "inspector", label: "Inspector" },
    ...(panels.ledger ? [{ key: "ledger" as const, label: "Ledger" }] : []),
    ...(panels.space ? [{ key: "space" as const, label: "Space" }] : []),
    ...(panels.mechanism ? [{ key: "mechanism" as const, label: "Mechanism" }] : []),
    ...(panels.materials ? [{ key: "materials" as const, label: "Materials" }] : []),
  ];
  return (
    <>
      {options.length > 1 && (
        <div className="k-tabs">
          <Pills ariaLabel="Right panel" value={tab} options={options} onChange={setTab} />
        </div>
      )}
      {tab === "ledger" && panels.ledger ? <LedgerPanel /> : tab === "space" && panels.space ? <DesignSpacePanel /> : tab === "mechanism" && panels.mechanism ? <MechanismPanel /> : tab === "materials" && panels.materials ? <MaterialsPanel /> : <InspectorPanel />}
    </>
  );
}

/** Chips at the viewport's bottom-left for something running that no open panel shows: a Sweep started
 *  from the ring or a hotkey while the Mechanism tab is hidden, with its Stop. */
export function ViewChips() {
  const sweeping = useMechanism((s) => s.sweeping);
  const watched = useMechanism((s) => s.watchers > 0);
  const chips = sweeping && !watched;
  if (!chips) return null;
  return (
    <div className="view-chips" role="status" aria-live="polite">
      {sweeping && !watched && (
        <span className="view-chip">
          <span>Sweeping {sweeping}…</span>
          <Button size="sm" onClick={() => useMechanism.getState().stopSweep()} title="Stop the sweep and put the drive back">Stop</Button>
        </span>
      )}
    </div>
  );
}
