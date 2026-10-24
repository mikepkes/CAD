import { useState } from "react";
import { useStore } from "../model/store";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (fast, balanced)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
];

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const close = () => useStore.getState().setSettingsOpen(false);
  const apiKey = useStore((s) => s.apiKey);
  const setApiKey = useStore((s) => s.setApiKey);
  const model = useStore((s) => s.agentModel);
  const setAgentModel = useStore((s) => s.setAgentModel);
  const [draft, setDraft] = useState(apiKey);

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
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={() => { setApiKey(draft.trim()); close(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
