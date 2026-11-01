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
import { FeatureToolPanel } from "./FeatureToolPanel";
import { SelectionHighlight } from "./SelectionHighlight";
import { ViewCube } from "./ViewCube";
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

function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    if (toast) {
      // a toast that offers a way forward stays long enough to take it
      const t = setTimeout(dismiss, toast.action ? 10000 : 4000);
      return () => clearTimeout(t);
    }
  }, [toast, dismiss]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} onClick={dismiss}>
      {toast.text}
      {toast.action && (
        <span className="toast-actions">
          <button className="btn primary" onClick={(e) => { e.stopPropagation(); toast.action!.run(); }}>{toast.action.label}</button>
          <button className="btn ghost" onClick={(e) => { e.stopPropagation(); dismiss(); }}>Cancel</button>
        </span>
      )}
    </div>
  );
}

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
      <Toolbar />
      {mode === "sketch" && <ConstraintBar />}
      <div className="workspace">
        <aside className={`side left ${leftOpen ? "" : "collapsed"}`} style={{ width: sideWidth.left, marginLeft: leftOpen ? 0 : -sideWidth.left }}>
          <BrowserPanel />
          <ParametersPanel />
          <TimelinePanel />
        </aside>
        {leftOpen && <SideResizer side="left" />}
        <button className="side-toggle left" onClick={() => setLeftOpen((v) => !v)}>
          {leftOpen ? "‹" : "›"}
        </button>

        <main className="center">
          <div className="center-view">
            <Viewport overlays={<>{workbench && <WorkbenchOverlay />}<LensOverlay /></>} />
            <PanelToggles />
            <Toast />
            <BuildProgress />
            <ExtrudePanel />
            <FeatureToolPanel />
            <SelectionHighlight />
            <ViewCube />
            <AgentPanel />
          </div>
          {workbench && mode === "model" && <div className="center-dock"><HistoryStrip /></div>}
        </main>

        <button className="side-toggle right" onClick={() => setRightOpen((v) => !v)}>
          {rightOpen ? "›" : "‹"}
        </button>
        {rightOpen && <SideResizer side="right" />}
        <aside className={`side right ${rightOpen ? "" : "collapsed"}`} style={{ width: sideWidth.right, marginRight: rightOpen ? 0 : -sideWidth.right }}>
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
