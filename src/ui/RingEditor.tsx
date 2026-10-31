// The ring section of the Hotkeys panel: pick a context, see its ring laid out
// like the ring itself (own slots bright, inherited ones dimmed with where they
// come from), click a slot to choose its action. Writes only through
// useRing.setSlot / resetContext / resetAll; what may go in a slot and how a
// slot reads come from ringConfig.ts.

import { useEffect, useReducer, useState } from "react";
import { hotkeys, prettyKey } from "../model/hotkeys";
import { CONTEXTS, CONTEXT_LABELS, ContextId } from "../model/contexts";
import { isCustomized, useRing } from "../model/ring";
import { activeStack, actionLabel, editorSlotPos, ringChoices, ringPreview, slotViews } from "../model/ringConfig";
import { Button, Pills } from "./kit/primitives";

/** The compass's half-width / half-height in px (an ellipse, so the labels fit the modal). */
const RX = 180, RY = 112;

export function RingEditor() {
  const overrides = useRing((s) => s.overrides);
  const [, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => hotkeys.subscribe(bump), []);
  const stack = activeStack();
  const [ctx, setCtx] = useState<ContextId>(() => stack[stack.length - 1] ?? "global");
  const [picking, setPicking] = useState<number | null>(null);

  const ring = useRing.getState();
  const slots = slotViews(ctx, overrides);
  const choices = ringChoices(ctx);
  const offered = new Set(choices.flatMap((g) => g.actions.map((a) => a.id)));
  const slot = picking == null ? null : slots[picking];

  const inheritText = (s: (typeof slots)[number]) =>
    s.inherited.actionId ? `Inherit (from ${CONTEXT_LABELS[s.inherited.from!]}: ${actionLabel(s.inherited.actionId)})` : "Inherit (nothing below: empty)";

  return (
    <div className="hk-ring">
      <p className="field-note">
        Hold Space (rebind “Action ring” under Keys), point, release. Right-click in the model opens it too.
        Each context has its own ring; an empty slot inherits the same slot from the contexts below.
      </p>
      <div className="hk-ring-ctx">
        <Pills
          ariaLabel="Ring context"
          value={ctx}
          onChange={(c) => { setCtx(c); }}
          options={CONTEXTS.map((c) => ({
            key: c,
            label: `${CONTEXT_LABELS[c]}${isCustomized(c, overrides) ? " •" : ""}`,
            title: `${stack.includes(c) ? "Active now" : "Not active now"}${isCustomized(c, overrides) ? " · customized" : ""}`,
          }))}
        />
      </div>

      <div className="hk-compass" role="group" aria-label={`${CONTEXT_LABELS[ctx]} ring`} style={{ height: 2 * RY + 60 }}>
        <div className="hk-compass-hub">{CONTEXT_LABELS[ctx]}</div>
        {slots.map((s) => {
          const p = editorSlotPos(s.index, RX, RY);
          const id = s.own ?? s.inherited.actionId;
          const inherits = s.own == null;
          return (
            <button
              key={s.index}
              type="button"
              className={`hk-slot${inherits ? " inherits" : ""}${picking === s.index ? " picking" : ""}`}
              style={{ left: `calc(50% + ${p.x}px)`, top: `calc(50% + ${p.y}px)` }}
              aria-label={`Slot ${s.name}`}
              aria-expanded={picking === s.index}
              data-slot={s.name}
              onClick={() => setPicking(picking === s.index ? null : s.index)}
            >
              <span className="hk-slot-name">{s.name}{s.overridden && <em className="hk-custom" title="Customized"> •</em>}</span>
              <span className="hk-slot-action">{id ? actionLabel(id) : "—"}</span>
              {inherits && s.inherited.from && <span className="hk-slot-from">from {CONTEXT_LABELS[s.inherited.from]}</span>}
            </button>
          );
        })}
      </div>

      {slot && (
        <div className="hk-slot-picker">
          <span className="hk-slot-picker-name">{slot.name}</span>
          <select
            className="k-select"
            aria-label={`Action for slot ${slot.name}`}
            value={slot.own ?? ""}
            onChange={(e) => ring.setSlot(ctx, slot.index, e.target.value || null)}
          >
            <option value="">{inheritText(slot)}</option>
            {slot.own && !offered.has(slot.own) && <option value={slot.own}>{actionLabel(slot.own)} (not available)</option>}
            {choices.filter((g) => g.actions.length).map((g) => (
              <optgroup key={g.context} label={g.label}>
                {g.actions.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}{a.primary ? ` · ${prettyKey(a.primary)}` : ""}</option>
                ))}
              </optgroup>
            ))}
          </select>
          {slot.overridden && (
            <Button size="sm" ghost onClick={() => ring.setSlot(ctx, slot.index, undefined)} title={`Default: ${slot.default ? actionLabel(slot.default) : "inherit"}`}>
              Reset to default
            </Button>
          )}
        </div>
      )}

      <p className="hk-ring-now" aria-label="Ring now">Ring now: {ringPreview(stack, overrides)}</p>

      <div className="hk-ring-foot">
        <Button size="sm" ghost disabled={!isCustomized(ctx, overrides)} onClick={() => ring.resetContext(ctx)}>Reset this ring</Button>
        <Button size="sm" ghost disabled={!Object.keys(overrides).length} onClick={() => ring.resetAll()}>Reset all rings</Button>
      </div>
    </div>
  );
}
