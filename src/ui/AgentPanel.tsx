import { useEffect, useRef, useState } from "react";
import { useStore } from "../model/store";

export function AgentPanel() {
  const open = useStore((s) => s.agentOpen);
  const chat = useStore((s) => s.agentChat);
  const running = useStore((s) => s.agentRunning);
  const apiKey = useStore((s) => s.apiKey);
  const send = useStore((s) => s.sendAgentMessage);
  const stop = useStore((s) => s.stopAgent);
  const clear = useStore((s) => s.clearAgentChat);
  const toggle = useStore((s) => s.toggleAgent);
  const openSettings = () => useStore.getState().setSettingsOpen(true);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [chat]);

  if (!open) return null;

  const submit = () => { const t = text.trim(); if (!t) return; setText(""); void send(t); };

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <span>✦ Agent</span>
        <div className="agent-head-btns">
          <button className="icon-btn" title="Settings" onClick={openSettings}>⚙</button>
          <button className="icon-btn" title="Clear conversation" onClick={clear} disabled={running}>⌫</button>
          <button className="icon-btn" title="Close" onClick={toggle}>✕</button>
        </div>
      </div>
      <div className="agent-chat" ref={listRef}>
        {chat.length === 0 && (
          <div className="agent-hello">
            {apiKey ? (
              <>Ask me to sketch. For example:<br /><em>“Draw a 60×40 rectangle centered on the origin with a 10mm hole in the middle, fully constrained.”</em></>
            ) : (
              <>Connect your Claude API key in <button className="linklike" onClick={openSettings}>Settings</button> to start.</>
            )}
          </div>
        )}
        {chat.map((m, i) => {
          if (m.role === "tool") return <div key={i} className={`agent-tool ${m.ok ? "" : "bad"}`}>{m.ok ? "✓" : "✗"} {m.name}{m.detail && m.detail !== "ok" ? ` — ${m.detail}` : ""}</div>;
          if (m.role === "error") return <div key={i} className="agent-msg error">{m.text}</div>;
          return <div key={i} className={`agent-msg ${m.role}`}>{m.text}</div>;
        })}
        {running && <div className="agent-tool running">… working</div>}
      </div>
      <div className="agent-input">
        <textarea
          value={text}
          placeholder={apiKey ? "Describe what to sketch…" : "Set an API key in Settings first"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          rows={2}
        />
        {running
          ? <button className="btn" onClick={stop}>Stop</button>
          : <button className="btn primary" onClick={submit} disabled={!text.trim()}>Send</button>}
      </div>
    </div>
  );
}
