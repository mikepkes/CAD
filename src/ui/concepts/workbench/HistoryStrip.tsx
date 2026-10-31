// The history as a strip of chips under the viewport, scoped to the active
// component: its features (and its descendants'), plus the assembly steps
// (joints, components, patterns) while the root is active. Rolled-back entries
// stay as ghosts; the range input and the chips move the global rollback marker.
// Features the scope hides are one chip at the end that activates the root.

import { Fragment } from "react";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { Button, Chip, Track } from "../../kit/primitives";
import { useFeatureRows, useActiveComponent } from "../../kit/useFeatureRows";
import { moreLabel, rangeValue, rowsInScope, snapRollback, stripEntries, stripRange, stripState } from "./workbench";

export function HistoryStrip() {
  const rows = useFeatureRows();
  const active = useActiveComponent();
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const moveRollback = useStore((s) => s.moveRollback);
  const activateComponent = useStore((s) => s.activateComponent);
  const setHotFeature = useUi((s) => s.setHotFeature);
  const hotFeature = useUi((s) => s.hotFeature);
  void rev;
  const doc = session.doc;
  const timelineLength = session.timeline.length;
  const entries = stripEntries(rows, doc, active, session.timeline, session.rollbackIndex);
  const hidden = rowsInScope(rows, doc, active).hidden;
  const st = stripState(entries, session.rollbackIndex, timelineLength);
  const range = stripRange(entries);

  return (
    <div className="k-dock wb-strip" role="region" aria-label="History">
      <div className="wb-strip-row">
        <div className="k-strip">
          {st.chips.map((c, i) => (
            <Fragment key={c.row.opId}>
              {i > 0 && <Track ghost={c.state === "ghost"} />}
              <Chip num={c.row.num} label={c.row.name} state={c.state} off={c.off} err={c.err} hot={c.row.featureId != null && hotFeature === c.row.featureId}
                className={c.row.step ? "wb-step" : undefined}
                title={c.row.error ?? (c.state === "ghost" ? "Rolled back — click to build up to here" : c.row.step ? `${c.row.step.label} — click to roll the history to just after this step` : "Click to roll the history to just after this feature")}
                onClick={() => void moveRollback(c.row.index + 1)}
                onHover={c.row.featureId != null ? (on) => setHotFeature(on ? c.row.featureId! : null) : undefined} />
            </Fragment>
          ))}
          {hidden > 0 && (
            <>
              {st.chips.length > 0 && <Track />}
              <Chip label={moreLabel(hidden)} className="wb-more k-dim" title="Features of other components — click to activate the root and see them all"
                onClick={() => activateComponent(doc.rootComponentId)} />
            </>
          )}
          {!st.chips.length && hidden === 0 && <span className="k-dim">{st.text}</span>}
        </div>
      </div>
      {st.chips.length > 0 && (
        <input
          className="wb-range"
          type="range"
          min={range.min}
          max={range.max}
          step={1}
          value={rangeValue(range, session.rollbackIndex)}
          aria-label="Rollback position"
          onChange={(e) => void moveRollback(snapRollback(range, Number(e.target.value)))}
        />
      )}
      <div className="wb-strip-foot">
        {(st.chips.length > 0 || hidden > 0) && <span className="k-dim">{st.text}</span>}
        {st.rolledBack && <Button size="sm" accent onClick={() => void moveRollback(timelineLength)}>Roll to end</Button>}
      </div>
    </div>
  );
}
