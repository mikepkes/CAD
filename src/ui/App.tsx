import { useState } from "react";
import { Viewport } from "./Viewport";
import { Toolbar } from "./Toolbar";
import { ConstraintBar } from "./ConstraintBar";
import { BrowserPanel } from "./BrowserPanel";
import { ParametersPanel } from "./ParametersPanel";
import { InspectorPanel } from "./InspectorPanel";
import { StatusBar } from "./StatusBar";
import { useStore } from "../model/store";

export function App() {
  const mode = useStore((s) => s.mode);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <div className="app">
      <Toolbar />
      {mode === "sketch" && <ConstraintBar />}
      <div className="workspace">
        <aside className={`side left ${leftOpen ? "" : "collapsed"}`}>
          <BrowserPanel />
          <ParametersPanel />
        </aside>
        <button className="side-toggle left" onClick={() => setLeftOpen((v) => !v)}>
          {leftOpen ? "‹" : "›"}
        </button>

        <main className="center">
          <Viewport />
        </main>

        <button className="side-toggle right" onClick={() => setRightOpen((v) => !v)}>
          {rightOpen ? "›" : "‹"}
        </button>
        <aside className={`side right ${rightOpen ? "" : "collapsed"}`}>
          <InspectorPanel />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
