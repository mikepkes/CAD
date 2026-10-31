// Pinned designs: up to three points of the map kept as cards (A, B, C) with
// their values, metric and verdict; "Go to" sets both parameters, "Compare"
// shows each metric's change from the pin to the current design.

import type { Metrics } from "../../../model/concepts/intents";
import { Button, Card, Readout } from "../../kit/primitives";
import { METRICS, formatMetric, formatDelta, metricDeltas, metricInfo, readoutState, type MetricKey, type Pin, type PinLetter } from "./space";

export interface PinnedProps {
  pins: Pin[];
  metric: MetricKey;
  /** The current design's metrics (the "to" side of a compare). */
  current: Metrics | null;
  compare: PinLetter | null;
  onGo: (pin: Pin) => void;
  onCompare: (letter: PinLetter | null) => void;
  onRemove: (letter: PinLetter) => void;
}

export function Pinned(p: PinnedProps) {
  if (!p.pins.length) return null;
  const info = metricInfo(p.metric);
  return (
    <div className="space-pins" role="list" aria-label="Pinned designs">
      {p.pins.map((pin) => {
        const comparing = p.compare === pin.letter;
        const deltas = comparing ? metricDeltas(pin.metrics, p.current) : null;
        return (
          <Card key={pin.letter} variant="inline" className="space-pin" role="listitem" ariaLabel={`Pin ${pin.letter}`} num={pin.letter} title={`${pin.xName} ${pin.x} · ${pin.yName} ${pin.y}`} headActions={<Button icon ghost size="sm" ariaLabel={`Remove pin ${pin.letter}`} onClick={() => p.onRemove(pin.letter)}>×</Button>}>
            <div className="space-readouts">
              <Readout label={info.label} value={formatMetric(pin.metrics?.[p.metric], p.metric)} state={readoutState(pin.verdict)} title={pin.verdict === "unknown" ? "not checked when pinned" : pin.verdict === "pass" ? "passed every intent" : "failed an intent"} />
              {deltas && METRICS.map((m) => (
                <Readout key={m.key} label={`Δ ${m.label}`} value={formatDelta(deltas[m.key], m.key)} title={`current minus pin ${pin.letter}`} />
              ))}
            </div>
            <div className="space-row">
              <Button size="sm" onClick={() => p.onGo(pin)} title={`Set ${pin.xName} and ${pin.yName} to this pin`}>Go to</Button>
              <Button size="sm" on={comparing} onClick={() => p.onCompare(comparing ? null : pin.letter)} title="Show how the current design differs from this pin">Compare</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
