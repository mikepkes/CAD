import { useState, useEffect } from "react";
import { Viewport } from "./Viewport";
import { Toolbar } from "./Toolbar";
import { ConstraintBar } from "./ConstraintBar";
import { BrowserPanel } from "./BrowserPanel";
import { ParametersPanel } from "./ParametersPanel";
import { InspectorPanel } from "./InspectorPanel";
import { TimelinePanel } from "./TimelinePanel";
import { StatusBar } from "./StatusBar";
import { SettingsPanel } from "./SettingsPanel";
import { AgentPanel } from "./AgentPanel";
import { useStore } from "../model/store";

function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(dismiss, 4000);
      return () => clearTimeout(t);
    }
  }, [toast, dismiss]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} onClick={dismiss}>
      {toast.text}
    </div>
  );
}

export function App() {
  const mode = useStore((s) => s.mode);
  const initApp = useStore((s) => s.initApp);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  useEffect(() => {
    void initApp();
  }, [initApp]);

  return (
    <div className="app">
      <Toolbar />
      {mode === "sketch" && <ConstraintBar />}
      <div className="workspace">
        <aside className={`side left ${leftOpen ? "" : "collapsed"}`}>
          <BrowserPanel />
          <ParametersPanel />
          <TimelinePanel />
        </aside>
        <button className="side-toggle left" onClick={() => setLeftOpen((v) => !v)}>
          {leftOpen ? "‹" : "›"}
        </button>

        <main className="center">
          <Viewport />
          <Toast />
          <AgentPanel />
        </main>

        <button className="side-toggle right" onClick={() => setRightOpen((v) => !v)}>
          {rightOpen ? "›" : "‹"}
        </button>
        <aside className={`side right ${rightOpen ? "" : "collapsed"}`}>
          <InspectorPanel />
        </aside>
      </div>
      <StatusBar />
      <SettingsPanel />
    </div>
  );
}
