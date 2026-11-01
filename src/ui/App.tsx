import { useState, useEffect } from "react";
import { Viewport } from "./Viewport";
import { Toolbar } from "./Toolbar";
import { ConstraintBar } from "./ConstraintBar";
import { BrowserPanel } from "./BrowserPanel";
import { ParametersPanel } from "./ParametersPanel";
import { TimelinePanel } from "./TimelinePanel";
import { StatusBar } from "./StatusBar";
import { SettingsPanel } from "./SettingsPanel";
import { AgentPanel } from "./AgentPanel";
import { ExtrudePanel } from "./ExtrudePanel";
import { HotkeyPanel } from "./HotkeyPanel";
import { useStore } from "../model/store";
import { installHotkeys } from "../model/hotkeyActions";
import { installContextActions } from "./concepts/contextActions";
import { useUi } from "../model/concepts/uiState";
import { WorkbenchOverlay, HistoryStrip } from "./concepts/workbench";
import { LensOverlay } from "./concepts/lens";
import { IntentLine } from "./concepts/intent";
import { PanelToggles, RightPanel } from "./ConceptShell";
import { Dialog } from "./kit/Dialog";
import { DrawingView } from "./DrawingView";
import { PickMenu } from "./PickMenu";
import { startAssist } from "../model/assistController";
import { registerAppPanels } from "../model/appPanels";
import { SideResizer } from "./SideResizer";
import { BuildProgress } from "./BuildProgress";
import { Toast } from "./Toast";
import { FirstRun } from "./FirstRun";

export function App() {
  const mode = useStore((s) => s.mode);
  const initApp = useStore((s) => s.initApp);
  const workbench = useUi((s) => s.panels.workbench);
  const sideWidth = useUi((s) => s.sideWidth);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  useEffect(() => {
    void initApp();
  }, [initApp]);

  useEffect(() => installHotkeys(), []);
  useEffect(() => installContextActions(), []);
  useEffect(() => startAssist(), []);
  useEffect(() => registerAppPanels(), []);

  return (
    <div className="app">
      <h1 className="sr-only">VibeCAD</h1>
      <Toolbar />
      {mode === "sketch" && <ConstraintBar />}
      <div className="workspace">
        <aside id="side-left" aria-label="Browser, parameters and history" className={`side left ${leftOpen ? "" : "collapsed"}`} style={{ width: sideWidth.left, marginLeft: leftOpen ? 0 : -sideWidth.left }}>
          <BrowserPanel />
          <ParametersPanel />
          <TimelinePanel />
        </aside>
        {leftOpen && <SideResizer side="left" />}
        <button className="side-toggle left" aria-controls="side-left" aria-expanded={leftOpen} aria-label={leftOpen ? "Hide the left panel" : "Show the left panel"} title={leftOpen ? "Hide the left panel" : "Show the left panel"} onClick={() => setLeftOpen((v) => !v)}>
          <span aria-hidden="true">{leftOpen ? "‹" : "›"}</span>
        </button>

        <main className="center">
          <div className="center-view">
            <Viewport overlays={<>{workbench && <WorkbenchOverlay />}<LensOverlay /></>} />
            <PanelToggles />
            <FirstRun />
            <Toast />
            <BuildProgress />
            <ExtrudePanel />
            <AgentPanel />
          </div>
          {workbench && mode === "model" && <div className="center-dock"><HistoryStrip /></div>}
        </main>

        <button className="side-toggle right" aria-controls="side-right" aria-expanded={rightOpen} aria-label={rightOpen ? "Hide the right panel" : "Show the right panel"} title={rightOpen ? "Hide the right panel" : "Show the right panel"} onClick={() => setRightOpen((v) => !v)}>
          <span aria-hidden="true">{rightOpen ? "›" : "‹"}</span>
        </button>
        {rightOpen && <SideResizer side="right" />}
        <aside id="side-right" aria-label="Inspector and concept panels" className={`side right ${rightOpen ? "" : "collapsed"}`} style={{ width: sideWidth.right, marginRight: rightOpen ? 0 : -sideWidth.right }}>
          <RightPanel />
        </aside>
      </div>
      <StatusBar />
      <IntentLine />
      <SettingsPanel />
      <HotkeyPanel />
      <Dialog />
      <DrawingView />
      <PickMenu />
    </div>
  );
}
