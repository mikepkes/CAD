// The history as a strip of chips under the viewport: rolled-back features stay
// as ghosts, the range input and the chips move the rollback marker.

import { Fragment } from "react";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { Button, Chip, Track } from "../../kit/primitives";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { rollbackIndexForStep, stripState } from "./workbench";

export function HistoryStrip() {
  const rows = useFeatureRows();
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const moveRollback = useStore((s) => s.moveRollback);
  const setHotFeature = useUi((s) => s.setHotFeature);
  const hotFeature = useUi((s) => s.hotFeature);
  void rev;
  const timelineLength = session.timeline.length;
  const st = stripState(rows, session.rollbackIndex, timelineLength);

  return (
    <div className="k-dock wb-strip" role="region" aria-label="History">
      <div className="wb-strip-row">
        <div className="k-strip">
          {st.chips.map((c, i) => (
            <Fragment key={c.row.featureId}>
              {i > 0 && <Track ghost={c.state === "ghost"} />}
              <Chip num={c.row.num} label={c.row.name} state={c.state} off={c.off} err={c.err} hot={hotFeature === c.row.featureId}
                title={c.row.error ?? (c.state === "ghost" ? "Rolled back — click to build up to here" : "Click to roll the history to just after this feature")}
                onClick={() => void moveRollback(c.row.index + 1)} onHover={(on) => setHotFeature(on ? c.row.featureId : null)} />
            </Fragment>
          ))}
          {!st.chips.length && <span className="k-dim">{st.text}</span>}
        </div>
      </div>
      {st.chips.length > 0 && (
        <input
          className="wb-range"
          type="range"
          min={0}
          max={rows.length}
          step={1}
          value={st.built}
          aria-label="Rollback position"
          onChange={(e) => void moveRollback(rollbackIndexForStep(rows, Number(e.target.value), timelineLength))}
        />
      )}
      <div className="wb-strip-foot">
        {st.chips.length > 0 && <span className="k-dim">{st.text}</span>}
        {st.rolledBack && <Button size="sm" accent onClick={() => void moveRollback(timelineLength)}>Roll to end</Button>}
      </div>
    </div>
  );
}
