import { useEffect, useState } from "react";
import { useStore } from "../model/store";
import { isTauri } from "../model/desktopMcp";
import { connectWebHid, onSpaceMouseStatus, setSpaceMouseSettings, spaceMouseSettings, spaceMouseStatus, webHidAvailable, SpaceMouseStatus } from "../model/spaceMouseInput";
import type { SpaceMouseSettings } from "../viewport/spaceMouse";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (fast, balanced)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
];

/** 3D mouse (3Dconnexion SpaceMouse): connection, speed, axes, buttons. */
function SpaceMouseSettingsSection() {
  const [st, setSt] = useState<SpaceMouseStatus>(spaceMouseStatus());
  const [cfg, setCfg] = useState(spaceMouseSettings());
  useEffect(() => onSpaceMouseStatus(setSt), []);
  const update = (patch: Partial<SpaceMouseSettings>) => { setSpaceMouseSettings(patch); setCfg(spaceMouseSettings()); };
  const axes = [["tx", "Pan left/right"], ["tz", "Pan up/down"], ["ty", "Zoom"], ["rx", "Tilt"], ["rz", "Spin"]] as const;
  const viewActions = ["view.frame", "view.iso", "view.front", "view.top", "view.right", "edit.undo", "edit.redo"];
  return (
    <>
      <label className="field-label">3D mouse</label>
      <p className="field-note">
        {st.source ? <><span className="ok-dot">●</span> {st.product ?? "Connected"} ({st.source === "native" ? "desktop" : "WebHID"})</> : st.note ?? "No 3D mouse connected."}
      </p>
      {!st.source && !isTauri() && webHidAvailable() && (
        <button className="btn ghost" onClick={() => void connectWebHid().then(setSt).catch((e) => setSt({ source: null, note: String(e?.message ?? e) }))}>Connect a 3D mouse…</button>
      )}
      <label className="field-label">Speed ({cfg.speed.toFixed(1)}×)</label>
      <input className="field-input" type="range" min={0.2} max={5} step={0.1} value={cfg.speed} onChange={(e) => update({ speed: Number(e.target.value) })} />
      <label className="field-toggle"><input type="checkbox" checked={cfg.lockRotation} onChange={(e) => update({ lockRotation: e.target.checked })} /><span>Pan and zoom only (no rotation)</span></label>
      <div className="field-note">Invert:{" "}
        {axes.map(([k, label]) => (
          <label key={k} className="toggle" style={{ marginRight: 8 }}><input type="checkbox" checked={!!cfg.invert[k]} onChange={(e) => update({ invert: { [k]: e.target.checked } })} /> {label}</label>
        ))}
      </div>
      {[0, 1].map((b) => (
        <div key={b} className="field-note">Button {b + 1}:{" "}
          <select className="field-input" style={{ width: "auto" }} value={cfg.buttons[b] ?? ""} onChange={(e) => update({ buttons: { ...cfg.buttons, [b]: e.target.value } })}>
            <option value="">(nothing)</option>
            {viewActions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      ))}
    </>
  );
}

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const close = () => useStore.getState().setSettingsOpen(false);
  const apiKey = useStore((s) => s.apiKey);
  const setApiKey = useStore((s) => s.setApiKey);
  const model = useStore((s) => s.agentModel);
  const setAgentModel = useStore((s) => s.setAgentModel);
  const webMcp = useStore((s) => s.webMcpEnabled);
  const setWebMcp = useStore((s) => s.setWebMcpEnabled);
  const desktopMcp = useStore((s) => s.desktopMcpEnabled);
  const setDesktopMcp = useStore((s) => s.setDesktopMcpEnabled);
  const desktopMcpPort = useStore((s) => s.desktopMcpPort);
  const setDesktopMcpPort = useStore((s) => s.setDesktopMcpPort);
  const desktopMcpStatus = useStore((s) => s.desktopMcp);
  const [draft, setDraft] = useState(apiKey);
  const [portDraft, setPortDraft] = useState(String(desktopMcpPort));

  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Settings · Claude agent</span>
          <button className="icon-btn" onClick={close}>✕</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Claude API key</label>
          <input
            className="field-input"
            type="password"
            placeholder="sk-ant-…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setApiKey(draft.trim())}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="field-note">
            Stored only in this browser (localStorage) and sent only to Anthropic’s API —
            never to any ChiselCAD server. Create one at{" "}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
          </p>

          <label className="field-label">Model</label>
          <select className="field-input" value={model} onChange={(e) => setAgentModel(e.target.value)}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <p className="field-note">The agent drives the same commands you use by hand — ask it to sketch, constrain, dimension, or extrude.</p>

          <div className="field-divider" />
          <label className="field-toggle">
            <input type="checkbox" checked={webMcp} onChange={(e) => setWebMcp(e.target.checked)} />
            <span>Expose tools to browser agents (WebMCP)</span>
          </label>
          <p className="field-note">
            Lets an external agent in your browser (an AI browser, a Chrome extension, Claude-in-Chrome)
            discover and call ChiselCAD’s {" "}
            <strong>commands as MCP tools</strong> to control this page directly — no server. Registers with
            <code> navigator.modelContext</code> when available, and always publishes
            <code> window.chiselWebMCP</code> (<code>.listTools()</code> / <code>.callTool(name, args)</code>).
            {webMcp && <> <span className="ok-dot">● live</span></>}
          </p>

          {isTauri() && (
            <>
              <div className="field-divider" />
              <label className="field-toggle">
                <input type="checkbox" checked={desktopMcp} onChange={(e) => void setDesktopMcp(e.target.checked)} />
                <span>Expose MCP server (desktop app)</span>
              </label>
              <p className="field-note">
                Serves the same tools to external MCP clients (Claude Code, Claude Desktop, …) over
                local HTTP, driving <strong>this live document</strong>. Streamable HTTP transport, bound to
                127.0.0.1 only.
              </p>
              <label className="field-label">Port</label>
              <input
                className="field-input"
                type="number"
                min={1024}
                max={65535}
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onBlur={() => { const n = Number(portDraft); if (n && n !== desktopMcpPort) setDesktopMcpPort(n); else setPortDraft(String(desktopMcpPort)); }}
              />
              {desktopMcp && desktopMcpStatus.running && desktopMcpStatus.url && (
                <p className="field-note">
                  <span className="ok-dot">● live</span> at <code>{desktopMcpStatus.url}</code>
                  <br />
                  Claude Code: <code>claude mcp add --transport http chisel-cad {desktopMcpStatus.url}</code>
                </p>
              )}
              {desktopMcp && !desktopMcpStatus.running && (
                <p className="field-note">
                  {desktopMcpStatus.error ? <>Not running: {desktopMcpStatus.error}</> : <>Starting…</>}
                </p>
              )}
            </>
          )}
          <div className="field-divider" />
          <SpaceMouseSettingsSection />
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={() => { setApiKey(draft.trim()); close(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
