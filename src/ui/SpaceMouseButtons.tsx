// 3D-mouse button bindings, per context: pick a context, then for each button
// an action from that context or those it sits on, "nothing here", or (above
// global) inherit. The same contexts and choices as the ring editor; the
// resolution is buttonMap.ts, which spaceMouseInput.ts runs on every press.

import { useEffect, useReducer, useState } from "react";
import { hotkeys, prettyKey } from "../model/hotkeys";
import { CONTEXTS, CONTEXT_LABELS, ContextId } from "../model/contexts";
import { actionChoices, actionLabel, activeStack } from "../model/ringConfig";
import { ButtonMap, buttonMapOf, buttonRows, inheritedButton, overridesButtons, resolveButton, setButton, settingsOf } from "../model/buttonMap";
import { onSpaceMouseButton, seenSpaceMouseButtons, setSpaceMouseSettings, spaceMouseSettings } from "../model/spaceMouseInput";
import { DEFAULT_SETTINGS } from "../viewport/spaceMouse";
import { Button, Pills } from "./kit/primitives";

const INHERIT = "__inherit";

export function SpaceMouseButtons() {
  const [, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => hotkeys.subscribe(bump), []);
  const [map, setMap] = useState<ButtonMap>(() => buttonMapOf(spaceMouseSettings()));
  const [ctx, setCtx] = useState<ContextId>(() => activeStack().slice(-1)[0] ?? "global");
  const [extra, setExtra] = useState(0);
  const [last, setLast] = useState<number | null>(null);
  const [seen, setSeen] = useState(seenSpaceMouseButtons);
  useEffect(() => onSpaceMouseButton((b) => { setLast(b); setSeen(seenSpaceMouseButtons()); }), []);

  const save = (next: ButtonMap) => { setSpaceMouseSettings(settingsOf(next)); setMap(next); };
  const rows = buttonRows(map, seen, extra);
  const own = map[ctx] ?? {};
  const choices = actionChoices(ctx).filter((g) => g.actions.length);
  const stack = activeStack();

  const inheritText = (b: number) => {
    const r = inheritedButton(b, ctx, map);
    return r.from ? `Inherit (${CONTEXT_LABELS[r.from]}: ${r.actionId ? actionLabel(r.actionId) : "nothing"})` : "Inherit (nothing)";
  };
  const nowText = (b: number) => {
    const r = resolveButton(b, stack, map, (id) => hotkeys.can(id));
    return r.actionId ? actionLabel(r.actionId) : "nothing";
  };

  return (
    <div className="smb" aria-label="3D mouse buttons">
      <Pills
        ariaLabel="Button context"
        value={ctx}
        onChange={setCtx}
        options={CONTEXTS.map((c) => ({ key: c, label: `${CONTEXT_LABELS[c]}${overridesButtons(c, map) ? " •" : ""}`, title: c === "global" ? "What each button does unless a context overrides it" : `Overrides while: ${CONTEXT_LABELS[c]}` }))}
      />
      {Array.from({ length: rows }, (_, b) => {
        const value = b in own ? own[b] : ctx === "global" ? "" : INHERIT;
        return (
          <div key={b} className={`field-note smb-row${last === b ? " smb-last" : ""}`}>
            <span className="smb-name">Button {b + 1}</span>
            <select
              className="field-input smb-select"
              aria-label={`Button ${b + 1} (${CONTEXT_LABELS[ctx]})`}
              value={value}
              onChange={(e) => save(setButton(map, ctx, b, e.target.value === INHERIT ? null : e.target.value))}
            >
              {ctx !== "global" && <option value={INHERIT}>{inheritText(b)}</option>}
              <option value="">{ctx === "global" ? "(nothing)" : "(nothing here)"}</option>
              {value && value !== INHERIT && !choices.some((g) => g.actions.some((a) => a.id === value)) && <option value={value}>{actionLabel(value)} (not available here)</option>}
              {choices.map((g) => (
                <optgroup key={g.context} label={g.label}>
                  {g.actions.map((a) => <option key={a.id} value={a.id}>{a.label}{a.primary ? ` · ${prettyKey(a.primary)}` : ""}</option>)}
                </optgroup>
              ))}
            </select>
            <span className="k-dim smb-now" title="What this button does right now, in the active contexts">now: {nowText(b)}</span>
          </div>
        );
      })}
      <div className="field-note">
        {last != null ? <>Last pressed: <b>Button {last + 1}</b>. </> : "Press a button on the device to find its number. "}
        <Button size="sm" ghost onClick={() => setExtra((n) => n + 1)}>Add a button</Button>{" "}
        {ctx === "global"
          ? <Button size="sm" ghost onClick={() => save({ ...map, global: { ...DEFAULT_SETTINGS.buttons } })}>Reset to defaults</Button>
          : <Button size="sm" ghost disabled={!overridesButtons(ctx, map)} onClick={() => { const next = { ...map }; delete next[ctx]; save(next); }}>Clear {CONTEXT_LABELS[ctx]} overrides</Button>}
      </div>
    </div>
  );
}
