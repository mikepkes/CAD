import { useState, useEffect, type CSSProperties } from "react";
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
import { useUi, fitSides, NARROW_PX } from "../model/concepts/uiState";
import { WorkbenchOverlay, HistoryStrip } from "./concepts/workbench";
import { LensOverlay } from "./concepts/lens";
import { IntentLine } from "./concepts/intent";
import { PanelToggles, RightPanel, ViewChips } from "./ConceptShell";
import { Dialog } from "./kit/Dialog";
import { DrawingView } from "./DrawingView";
import { PickMenu } from "./PickMenu";
import { startAssist } from "../model/assistController";
import { registerAppPanels } from "../model/appPanels";
import { SideResizer } from "./SideResizer";
import { BuildProgress } from "./BuildProgress";
import { Toast } from "./Toast";
import { FirstRun } from "./FirstRun";

/** The window's width, followed. */
function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function App() {
  const mode = useStore((s) => s.mode);
  const initApp = useStore((s) => s.initApp);
  const workbench = useUi((s) => s.panels.workbench);
  const storedWidth = useUi((s) => s.sideWidth);
  const sideOpen = useUi((s) => s.sideOpen);
  const setSideOpen = useUi((s) => s.setSideOpen);
  const leftOpen = sideOpen.left, rightOpen = sideOpen.right;
  const windowW = useWindowWidth();
  // the view keeps MIN_VIEW between the panels; on a narrow window they float at a fixed size (styles.css)
  const sideWidth = fitSides(storedWidth, sideOpen, windowW);
  const narrow = windowW < NARROW_PX;
  useEffect(() => { if (narrow) { setSideOpen("left", false); setSideOpen("right", false); } }, [narrow, setSideOpen]);

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
      <div className={`workspace${leftOpen ? "" : " left-collapsed"}${rightOpen ? "" : " right-collapsed"}`}
        style={{ "--side-left": `${narrow ? 240 : sideWidth.left}px`, "--side-right": `${narrow ? 240 : sideWidth.right}px` } as CSSProperties}>
        <aside id="side-left" aria-label="Browser, parameters and history" className={`side left ${leftOpen ? "" : "collapsed"}`} style={{ width: sideWidth.left, marginLeft: leftOpen ? 0 : -sideWidth.left }}>
          <BrowserPanel />
          <ParametersPanel />
          <TimelinePanel />
        </aside>
        {leftOpen && <SideResizer side="left" />}
        <button className={`side-toggle left${leftOpen ? " open" : ""}`} aria-controls="side-left" aria-expanded={leftOpen} aria-label={leftOpen ? "Hide the left panel" : "Show the left panel"} title={leftOpen ? "Hide the left panel" : "Show the left panel"} onClick={() => setSideOpen("left", !leftOpen)}>
          <span aria-hidden="true">{leftOpen ? "‹" : "›"}</span>
        </button>

        <main className="center">
          <div className="center-view">
            <Viewport overlays={<>{workbench && <WorkbenchOverlay />}<LensOverlay /></>} />
            <PanelToggles />
            <ViewChips />
            <FirstRun />
            <Toast />
            <BuildProgress />
            <ExtrudePanel />
            <AgentPanel />
          </div>
          {workbench && mode === "model" && <div className="center-dock"><HistoryStrip /></div>}
        </main>

        <button className={`side-toggle right${rightOpen ? " open" : ""}`} aria-controls="side-right" aria-expanded={rightOpen} aria-label={rightOpen ? "Hide the right panel" : "Show the right panel"} title={rightOpen ? "Hide the right panel" : "Show the right panel"} onClick={() => setSideOpen("right", !rightOpen)}>
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
