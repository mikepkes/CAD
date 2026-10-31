// The Design Space panel: pick two bounded parameters and a metric, sample the
// grid on a second geometry backend, and steer the design by dragging the point
// on the map. Every edit goes through useStore.setParameterExpr; all decisions
// about numbers live in space.ts / sampler.ts. Intents, their results and the
// mass density come from the shared intents store (one evaluation for every
// concept).
//
// Mounts as a tab in the right side panel (toggled by useUi.panels.space). No
// props are required; `createBackend` is a seam for tests and for an
// integration that wants to share a backend. The sampler backend outlives the
// panel and is disposed when the Space panel is switched off.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../../model/store";
import { useUi } from "../../../model/concepts/uiState";
import { useIntents } from "../../../model/concepts/intentsStore";
import type { GeometryBackend } from "../../../core/geometry/backend";
import { Button, Pills, Readout, Select } from "../../kit/primitives";
import { createEditQueue } from "../../kit/editQueue";
import {
  GRID_SIZES, METRICS, boundedParams, pickAxes, axisOf, judgeCell, mappableIntents, lightestPassing, formatMetric, metricInfo, verdictOf, docSignature, gridKey, cellKey,
  resultsFor, readoutState, intentsText, statusText, swapAxes, pinMove,
  type CellSample, type CellVerdict, type GridSize, type GridSpec, type MetricKey, type Move, type Pin, type SampleStatus,
} from "./space";
import { GridCache, disposeSamplerBackend, getSamplerBackend, sampleGrid } from "./sampler";
import { useSpace } from "./spaceState";
import { DesignSpaceMap } from "./Map";
import { Pinned } from "./Pinned";
import "./space.css";

export interface DesignSpacePanelProps {
  /** How the sampling backend is made (default: a second kernel backend of the store's kind). */
  createBackend?: () => Promise<GeometryBackend>;
}

const cache = new GridCache();
/** Forget every sampled grid and the sampler backend (tests, or after the kernel is swapped). */
export function clearGridCache(): void { cache.clear(); disposeSamplerBackend(); }

// The panel is unmounted on every tab switch; the backend goes only when the Space panel itself is switched off.
useUi.subscribe((s, prev) => { if (prev.panels.space && !s.panels.space) disposeSamplerBackend(); });

/** One parameter edit in flight: the newest requested point wins; each move names its own axes. */
function createMoveQueue() {
  return createEditQueue<Move>(async (v) => {
    const st = useStore.getState();
    const sc = st.session.doc.parameters;
    const cx = sc.find((q) => q.name === v.xName)?.value, cy = sc.find((q) => q.name === v.yName)?.value;
    if (cx !== v.x) await st.setParameterExpr(v.xName, String(v.x));
    if (cy !== v.y) await st.setParameterExpr(v.yName, String(v.y));
  });
}

export function DesignSpacePanel(p: DesignSpacePanelProps = {}) {
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const doc = session.doc;
  const { xName, yName, n, metric, pins, compare, setAxes, setN, setMetric, pin, unpin, setCompare } = useSpace();

  const bounded = useMemo(() => boundedParams(doc.parameters), [doc.parameters, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const axes = pickAxes(bounded, xName, yName);
  const spec: GridSpec | null = axes ? { x: axisOf(axes[0]), y: axisOf(axes[1]), n } : null;

  // ---- intents and the current design, from the shared store ----
  const allIntents = useIntents((s) => s.intents);
  const results = useIntents((s) => s.results);
  const scope = useIntents((s) => s.scope);
  const metrics = useIntents((s) => s.metrics);
  const density = useIntents((s) => s.density);
  const densitySource = useIntents((s) => s.densitySource);
  const intents = useMemo(() => mappableIntents(allIntents, scope), [allIntents, scope]);
  const current = spec ? { x: scope[spec.x.name] ?? spec.x.min, y: scope[spec.y.name] ?? spec.y.min } : null;
  const currentResults = useMemo(() => resultsFor(results, intents), [results, intents]);
  const verdict = verdictOf(currentResults, metrics.bodies > 0);

  // ---- sampling ----
  const signature = spec ? docSignature(session.timeline, session.rollbackIndex, doc.activeConfiguration, [spec.x.name, spec.y.name]) : "";
  const key = spec ? gridKey(spec, signature) : "";
  const [samples, setSamples] = useState<Map<number, CellSample>>(() => new Map());
  const [status, setStatus] = useState<SampleStatus>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const runToken = useRef(0);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (!spec || !key) { setStatus("idle"); return; }
    const token = ++runToken.current;
    const store = cache.open(key);
    setSamples(new Map(store));
    const total = spec.n * spec.n;
    if (store.size >= total) { setStatus("done"); setProgress({ done: total, total }); return; }
    setStatus("starting"); setError(null); setProgress({ done: store.size, total });
    const docSnapshot = doc;
    (async () => {
      try {
        const backend = await getSamplerBackend(p.createBackend);
        if (token !== runToken.current) return;
        setStatus("sampling");
        const res = await sampleGrid(backend, docSnapshot, spec, {
          skip: (i, j) => store.has(cellKey(i, j, spec.n)),
          cancelled: () => token !== runToken.current,
          onCell: (cell, done, tot) => {
            store.set(cellKey(cell.i, cell.j, spec.n), cell);
            setSamples(new Map(store));
            setProgress({ done, total: tot });
          },
        });
        if (token !== runToken.current) return;
        setStatus(res ? "done" : "idle");
      } catch (e) {
        if (token !== runToken.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => { runToken.current++; };
  }, [key, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { runToken.current++; }, []);

  const cells = useMemo<(CellVerdict | undefined)[]>(() => {
    if (!spec) return [];
    const out: (CellVerdict | undefined)[] = new Array(spec.n * spec.n);
    for (const s of samples.values()) out[cellKey(s.i, s.j, spec.n)] = judgeCell(s, doc, spec, intents, density);
    return out;
  }, [samples, doc, spec?.x.name, spec?.y.name, n, intents, density]); // eslint-disable-line react-hooks/exhaustive-deps
  const lightest = spec ? lightestPassing(cells, metric, spec.n) : null;

  // ---- steering: one edit in flight, the latest request wins ----
  const queue = useRef(createMoveQueue());
  const move = (x: number, y: number) => { if (spec) queue.current.live({ xName: spec.x.name, yName: spec.y.name, x, y }); };
  const commit = () => { void queue.current.flush(); };
  const goTo = (m: Move) => { queue.current.live(m); commit(); };

  const cancel = () => { runToken.current++; setStatus("idle"); };
  const resample = () => { cache.open(key).clear(); setRunId((r) => r + 1); };

  if (!spec || !current) {
    return (
      <div className="space-panel" data-testid="space-empty">
        <span className="k-label">Design space</span>
        <p className="k-dim">Set a min and max on at least two parameters in the Parameters panel to map them here. {bounded.length === 1 ? `Only "${bounded[0].name}" has bounds so far.` : "None have bounds yet."}</p>
      </div>
    );
  }

  const info = metricInfo(metric);
  const currentMetrics = metrics.bodies ? metrics : null;
  const currentMetric = formatMetric(currentMetrics?.[metric], metric);
  const selectAxis = (which: "x" | "y", name: string) => { const a = swapAxes(spec, which, name); setAxes(a.x, a.y); };
  const pinCurrent = () => pin({ x: current.x, y: current.y, xName: spec.x.name, yName: spec.y.name, metrics: currentMetrics, verdict });
  const onGo = (pn: Pin) => { setAxes(pn.xName, pn.yName); goTo(pinMove(pn)); };
  const paramOptions = bounded.map((q) => ({ key: q.name, label: q.name }));

  return (
    <div className="space-panel">
      <div className="space-row">
        <label className="k-label">X <Select className="space-select" ariaLabel="X parameter" value={spec.x.name} options={paramOptions} onChange={(v) => selectAxis("x", v)} /></label>
        <label className="k-label">Y <Select className="space-select" ariaLabel="Y parameter" value={spec.y.name} options={paramOptions} onChange={(v) => selectAxis("y", v)} /></label>
        <label className="k-label">Shade <Select className="space-select" ariaLabel="Metric" value={metric} title={info.estimate ? `Estimated: volume × density, ${densitySource}` : "From the kernel"} options={METRICS.map((m) => ({ key: m.key, label: m.label }))} onChange={(v) => setMetric(v as MetricKey)} /></label>
        <Pills ariaLabel="Grid size" value={String(n) as `${GridSize}`} options={GRID_SIZES.map((g) => ({ key: String(g) as `${GridSize}`, label: `${g}×${g}` }))} onChange={(k) => setN(Number(k) as GridSize)} />
      </div>
      <DesignSpaceMap spec={spec} cells={cells} metric={metric} intents={intents} current={current} verdict={verdict} currentMetric={`${info.label} ${currentMetric}`} lightest={lightest} pins={pins} onMove={move} onCommit={commit} />
      <div className="space-row">
        <Readout label={info.label} value={currentMetric} state={readoutState(verdict)} title={info.estimate ? `Estimate: ${densitySource}` : "From the kernel"} />
        <Readout label="Intents" value={intentsText(currentResults)} state={intents.length ? readoutState(verdict) : undefined} title={allIntents.length > intents.length ? `${allIntents.length - intents.length} intent(s) use names the map cannot evaluate and are not drawn` : "Intents from the Ledger"} />
        <span className="k-num k-dim space-progress" aria-live="polite">{statusText(status, progress, error)}</span>
      </div>
      <div className="space-row">
        {status === "sampling" || status === "starting" ? <Button size="sm" onClick={cancel}>Cancel</Button> : <Button size="sm" onClick={resample} title="Discard the cached grid and sample again">Resample</Button>}
        <Button size="sm" accent disabled={!lightest} onClick={() => lightest && goTo({ xName: spec.x.name, yName: spec.y.name, x: lightest.x, y: lightest.y })} title={lightest ? `${spec.x.name} ${lightest.x}, ${spec.y.name} ${lightest.y}: ${formatMetric(lightest.metrics?.[metric], metric)}` : "No passing cell sampled yet"}>Jump to lightest</Button>
        <Button size="sm" disabled={pins.length >= 3} onClick={pinCurrent} title="Keep this design as a pin (A, B, C)">Pin</Button>
      </div>
      <Pinned pins={pins} metric={metric} current={currentMetrics} compare={compare} onGo={onGo} onCompare={setCompare} onRemove={unpin} />
    </div>
  );
}

export default DesignSpacePanel;
