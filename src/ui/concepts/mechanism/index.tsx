// The Mechanism tab (right side panel, while useUi.panels.mechanism is on): a
// compliant mechanism's force–travel curve along its drive, with its rest
// positions, the tipping point and the snap force; a marker at the drive's
// current value; a Sweep that runs the drive across its range; and how hard each
// flexure is working. A template over mechanism.ts; the numbers come from
// mechanismStore (which runs the solver off the render path).

import { useEffect } from "react";
import { useStore } from "../../../model/store";
import { useMechanism, activeDrive } from "../../../model/concepts/mechanismStore";
import { barFill, drivesOf, fmt, fmtDrive, fmtEffort, restSentence, strainBars } from "../../../model/concepts/mechanism";
import { hasFlexures, isAngularDrive } from "../../../sim/flexure";
import { Button, Pills, Readout } from "../../kit/primitives";
import { ForceChart } from "./ForceChart";
import "./mechanism.css";

export function MechanismPanel() {
  useEffect(() => useMechanism.getState().follow(), []);
  useStore((s) => s.rev); // re-render as the model changes
  const doc = useStore((s) => s.session.doc);
  const chosen = useMechanism((s) => s.drive);
  const pose = useMechanism((s) => s.pose);
  const curves = useMechanism((s) => s.curves);
  const studying = useMechanism((s) => s.studying);
  const sweeping = useMechanism((s) => s.sweeping);
  const m = useMechanism.getState();

  if (!hasFlexures(doc)) {
    return (
      <section className="panel mech" aria-label="Mechanism">
        <p className="mech-empty k-dim" data-testid="mechanism-empty">No flexures or beams in this model. The Mechanism tab reads compliant mechanisms: open the bistable switch, the gripper or the four-bar from the examples.</p>
      </section>
    );
  }

  const drives = drivesOf(doc);
  const drive = activeDrive(chosen);
  const angular = drive ? isAngularDrive(doc, drive.name) : false;
  const curve = drive ? curves[drive.name]?.curve : undefined;
  const live = pose && drive && pose.drive === drive.name ? pose : null;
  const bars = pose ? strainBars(pose.state) : [];
  const limit = pose?.state.flexures.find((f) => f.allowable)?.allowable;

  return (
    <section className="panel mech" aria-label="Mechanism">
      <div className="mech-head">
        <span className="k-label">Compliant mechanism</span>
        {drives.length > 1 && drive && (
          <Pills ariaLabel="Drive" value={drive.name} options={drives.map((d) => ({ key: d.name, label: d.name }))} onChange={(k) => m.setDrive(k)} />
        )}
      </div>

      {drive ? (
        <>
          {curve
            ? <ForceChart curve={curve} value={drive.value} />
            : <div className="mech-chart-wait k-dim" data-testid="curve-pending">{studying ? "Sweeping the range…" : "Reading the mechanism…"}</div>}
          <div className="mech-key k-dim" aria-hidden="true">
            <span><i className="mech-key-stable" />rest</span>
            <span><i className="mech-key-unstable" />tipping point</span>
            <span><i className="mech-key-snap" />snap</span>
            <span><i className="mech-key-now" />now</span>
          </div>
          {curve && <p className="mech-sentence" data-testid="rest-sentence">{restSentence(curve)}</p>}
          <div className="mech-readouts">
            <Readout label={drive.name} value={fmtDrive(drive.value, angular)} />
            <Readout label={angular ? "Torque" : "Force"} value={live ? fmtEffort(live.effort, angular) : "–"}
              title={`dU/d${drive.name}: what it takes to hold it here (positive pushes ${drive.name} up). From the flexure model, an estimate.`} />
          </div>
          <Button accent={!sweeping} on={!!sweeping} ariaLabel={sweeping ? "Stop sweep" : `Sweep ${drive.name}`}
            title={`Run ${drive.name} from ${fmt(drive.value)} up to ${fmt(drive.max!)}, down to ${fmt(drive.min!)} and back`}
            onClick={() => (sweeping ? m.stopSweep() : void m.sweep(drive.name))}>
            {sweeping ? "Stop sweep" : `Sweep ${drive.name}`}
          </Button>
        </>
      ) : (
        <p className="mech-empty k-dim">No bounded parameter drives this mechanism: give its drive a min and max to chart it.</p>
      )}

      <div className="mech-strain">
        <div className="mech-strain-head">
          <span className="k-label">Flexure strain</span>
          <span className="k-dim">{limit ? `of the limit (${fmt(limit * 100, 2)}%)` : "peak strain"}</span>
        </div>
        <ul className="mech-bars" aria-label="Flexure strain">
          {bars.map((b) => (
            <li key={b.joint} className={b.over ? "over" : ""} aria-label={`${b.name}: ${Number.isFinite(b.pct) ? `${Math.round(b.pct)}% of its limit` : `${fmt(b.strain * 100, 2)}% strain`}`}>
              <span className="mech-bar-name">{b.name}</span>
              <span className="mech-bar-track"><span className="mech-bar-fill" style={barFill(b.pct)} /></span>
              <span className="mech-bar-val k-num">{Number.isFinite(b.pct) ? `${Math.round(b.pct)}%` : `${fmt(b.strain * 100, 2)}%ε`}</span>
            </li>
          ))}
          {!bars.length && <li className="k-dim">Reading…</li>}
        </ul>
      </div>
    </section>
  );
}

